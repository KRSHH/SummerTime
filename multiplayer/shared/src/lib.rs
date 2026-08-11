//! P2P multiplayer transport for SummerTime, built on iroh-gossip.
//!
//! Everyone is in one hardcoded room — there are no rooms, join codes, or
//! servers. Peers find each other through a tiny "beacon":
//!
//!  - [`ROOM_SEED`] is a fixed 32-byte value. It doubles as the gossip
//!    [`TopicId`] (the broadcast scope) and as a secret key whose public
//!    key is the room's rendezvous address on the public pkarr relay
//!    (`dns.iroh.link`).
//!  - Every client periodically publishes its own [`EndpointInfo`]
//!    (endpoint id + relay url) signed with the room key, and resolves the
//!    room key to learn the address of whoever else is in the room.
//!  - Discovered peers are fed to the gossip swarm via
//!    [`GossipSender::join_peers`]; the swarm then maintains membership and
//!    broadcast trees on its own (HyParView/PlumTree).
//!
//! Browser nodes cannot hole-punch (no UDP in browsers), so all traffic
//! flows through n0's free public relays over WebSocket — still end-to-end
//! encrypted and peer-to-peer in every other respect. No application server
//! is involved anywhere.
//!
//! Messages are signed (ed25519) and include a sequence number + timestamp,
//! both to authenticate senders (gossip itself has no auth) and to avoid
//! iroh-gossip's content-hash dedup collapsing repeated game-state frames.

use std::{
    collections::HashSet,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use anyhow::{Context, Result};
use iroh::{
    Endpoint, EndpointId, PublicKey, SecretKey, Signature,
    address_lookup::pkarr::{N0_DNS_PKARR_RELAY_PROD, PkarrRelayClient},
    endpoint::presets::N0,
    endpoint_info::{EndpointData, EndpointInfo, UserData},
    protocol::Router,
};
use iroh_gossip::{
    api::{Event as GossipEvent, GossipSender},
    net::{GOSSIP_ALPN, Gossip},
    proto::TopicId,
};
use n0_future::{
    StreamExt,
    boxed::BoxStream,
    task::{self, AbortOnDropHandle},
    time::{Duration, SystemTime},
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as TokioMutex;
use tracing::{debug, info, warn};

/// Fixed 32-byte seed of the single shared room: gossip topic id AND the
/// secret key of the room's pkarr rendezvous address. Hardcoded on purpose —
/// every client in the world joins the same room.
pub const ROOM_SEED: [u8; 32] = *b"summertime-p2p-room-v1\0\0\0\0\0\0\0\0\0\0";

/// How often the beacon publishes/resolves the room address.
pub const BEACON_INTERVAL: Duration = Duration::from_secs(3);

/// TTL of the beacon records on the pkarr relay.
pub const BEACON_TTL: u32 = 30;

/// A single peer in the room: broadcast + peer-join handle.
#[derive(Clone)]
pub struct RoomSender {
    inner: Arc<TokioMutex<GossipSender>>,
    secret_key: SecretKey,
    seq: Arc<AtomicU64>,
    /// Keeps the room beacon task alive for as long as the sender exists.
    _beacon: Arc<AbortOnDropHandle<()>>,
}

impl RoomSender {
    /// Signs and broadcasts a raw game-state body to everyone in the room.
    pub async fn broadcast(&self, body: Vec<u8>) -> Result<()> {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let timestamp = now_micros();
        let wire = WireState { seq, timestamp, body };
        let data = postcard::to_stdvec(&wire)?;
        let signature = self.secret_key.sign(&data);
        let signed = SignedState {
            from: self.secret_key.public(),
            data,
            signature,
        };
        let encoded = postcard::to_stdvec(&signed)?;
        self.inner
            .lock()
            .await
            .broadcast(encoded.into())
            .await?;
        Ok(())
    }

    /// Asks the swarm to dial and join the given peers (used by the beacon).
    pub async fn join_peers(&self, peers: Vec<EndpointId>) -> Result<()> {
        self.inner.lock().await.join_peers(peers).await?;
        Ok(())
    }
}

/// The P2P node: one iroh endpoint running the gossip protocol.
pub struct SummerNode {
    secret_key: SecretKey,
    endpoint: Endpoint,
    router: Router,
    gossip: Gossip,
}

impl SummerNode {
    /// Spawns the endpoint + gossip protocol. Uses n0's default discovery
    /// (pkarr publish/resolve via dns.iroh.link) and default public relays.
    pub async fn spawn(secret_key: Option<SecretKey>) -> Result<Self> {
        let secret_key = secret_key.unwrap_or_else(SecretKey::generate);
        let endpoint = Endpoint::builder(N0)
            .secret_key(secret_key.clone())
            .alpns(vec![GOSSIP_ALPN.to_vec()])
            .bind()
            .await?;
        info!(endpoint_id = %endpoint.id(), "endpoint bound");

        let gossip = Gossip::builder().spawn(endpoint.clone());
        let router = Router::builder(endpoint.clone())
            .accept(GOSSIP_ALPN, gossip.clone())
            .spawn();
        info!("gossip + router spawned");

        Ok(Self {
            secret_key,
            endpoint,
            router,
            gossip,
        })
    }

    /// This node's identity (the id other peers dial).
    pub fn endpoint_id(&self) -> EndpointId {
        self.router.endpoint().id()
    }

    /// Joins the single hardcoded room.
    ///
    /// Returns a [`RoomSender`] for broadcasting state and a stream of
    /// [`Event`]s (verified messages + swarm membership changes).
    pub async fn join_room(&self) -> Result<(RoomSender, BoxStream<Result<Event>>)> {
        let topic_id = TopicId::from_bytes(ROOM_SEED);
        let topic = self
            .gossip
            .subscribe(topic_id, Vec::new())
            .await
            .context("failed to subscribe to room topic")?;
        let (raw_sender, receiver) = topic.split();

        let sender = RoomSender {
            inner: Arc::new(TokioMutex::new(raw_sender.clone())),
            secret_key: self.secret_key.clone(),
            seq: Arc::new(AtomicU64::new(1)),
            // Room beacon: publishes our address under the room key and
            // joins discovered room members as gossip peers. It shares the
            // gossip sender and lives as long as the RoomSender exists.
            _beacon: Arc::new(AbortOnDropHandle::new(task::spawn(beacon_loop(
                self.endpoint.clone(),
                raw_sender,
                SecretKey::from_bytes(&ROOM_SEED),
            )))),
        };

        // Map gossip events → application events, verifying signatures.
        let receiver = n0_future::stream::try_unfold(receiver, |mut receiver| async move {
            loop {
                let Some(event) = receiver.try_next().await? else {
                    return Ok(None);
                };
                let event: Event = match event.try_into() {
                    Ok(event) => event,
                    Err(err) => {
                        warn!("dropping invalid room message: {err:#}");
                        continue;
                    }
                };
                break Ok(Some((event, receiver)));
            }
        });

        Ok((sender, Box::pin(receiver)))
    }

    /// Clean shutdown (mainly for the native CLI; the browser unloads).
    pub async fn shutdown(&self) {
        if let Err(err) = self.router.shutdown().await {
            warn!("failed to shutdown router: {err}");
        }
        self.router.endpoint().close().await;
    }
}

/// Events surfaced to the application.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    /// A verified, decoded state broadcast from a peer.
    #[serde(rename_all = "camelCase")]
    MessageReceived {
        from: EndpointId,
        data: Vec<u8>,
        sent_timestamp: u64,
    },
    /// A direct gossip neighbor came online (swarm membership grew).
    #[serde(rename_all = "camelCase")]
    NeighborUp { endpoint_id: EndpointId },
    /// A direct gossip neighbor went offline.
    #[serde(rename_all = "camelCase")]
    NeighborDown { endpoint_id: EndpointId },
    /// The event stream fell behind and some messages were dropped.
    Lagged,
}

impl TryFrom<GossipEvent> for Event {
    type Error = anyhow::Error;

    fn try_from(event: GossipEvent) -> Result<Self, Self::Error> {
        Ok(match event {
            GossipEvent::NeighborUp(endpoint_id) => Self::NeighborUp { endpoint_id },
            GossipEvent::NeighborDown(endpoint_id) => Self::NeighborDown { endpoint_id },
            GossipEvent::Lagged => Self::Lagged,
            GossipEvent::Received(message) => {
                let signed: SignedState = postcard::from_bytes(&message.content)
                    .context("failed to decode signed state")?;
                signed
                    .from
                    .verify(&signed.data, &signed.signature)
                    .context("failed to verify state signature")?;
                let wire: WireState =
                    postcard::from_bytes(&signed.data).context("failed to decode wire state")?;
                Self::MessageReceived {
                    from: signed.from,
                    data: wire.body,
                    sent_timestamp: wire.timestamp,
                }
            }
        })
    }
}

/// Signed envelope broadcast over gossip: `data` is a [`WireState`].
#[derive(Debug, Serialize, Deserialize)]
struct SignedState {
    from: PublicKey,
    data: Vec<u8>,
    signature: Signature,
}

/// Inner payload of a broadcast, signed as a whole.
#[derive(Debug, Serialize, Deserialize)]
struct WireState {
    /// Per-sender monotonic counter — guarantees unique content per frame
    /// (gossip dedups by content hash) and lets receivers drop stragglers.
    seq: u64,
    /// Microseconds since the unix epoch.
    timestamp: u64,
    /// Application payload (the encoded character state).
    body: Vec<u8>,
}

fn now_micros() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64
}

// ---------------------------------------------------------------------------
// Room beacon: zero-signaling rendezvous on the public pkarr relay
// ---------------------------------------------------------------------------

async fn beacon_loop(endpoint: Endpoint, sender: GossipSender, room_key: SecretKey) {
    let relay_url: url::Url = N0_DNS_PKARR_RELAY_PROD.parse().expect("static url");
    #[cfg(wasm_browser)]
    let client = PkarrRelayClient::new(relay_url);
    #[cfg(not(wasm_browser))]
    let client = PkarrRelayClient::new(
        relay_url,
        endpoint.tls_config().clone(),
        iroh::dns::DnsResolver::default(),
    );

    let room_id: EndpointId = room_key.public();
    let mut discovered: HashSet<EndpointId> = HashSet::new();

    info!("room beacon started (room id {room_id})");
    loop {
        publish_beacon(&client, &endpoint, &room_key).await;

        match client.resolve(room_id).await {
            Ok(packet) => match EndpointInfo::from_pkarr_signed_packet(&packet) {
                Ok(info) => {
                    // The record is addressed by the room key, so the real
                    // peer id arrives as user data (see publish_beacon).
                    let peer = info
                        .user_data()
                        .and_then(|ud| ud.as_ref().parse::<EndpointId>().ok());
                    if let Some(peer) = peer {
                        if peer != endpoint.id() && discovered.insert(peer) {
                            info!("discovered room peer {peer}, joining");
                            if let Err(err) = sender.join_peers(vec![peer]).await {
                                warn!("failed to join discovered peer {peer}: {err:#}");
                            }
                        }
                    }
                }
                Err(err) => debug!("room beacon record unparseable: {err:#}"),
            },
            Err(err) => debug!("room beacon resolve failed: {err:#}"),
        }

        n0_future::time::sleep(BEACON_INTERVAL).await;
    }
}

/// Publishes this endpoint's current address (id + home relay) signed with
/// the room key, so other room members can find us. Skipped until the
/// endpoint has a home relay (browsers connect to their relay on bind).
///
/// The pkarr record is addressed by the room key, and its parsed endpoint id
/// is always the packet key (the room key itself), so the real endpoint id
/// rides along as user data — that is what room members resolve to.
async fn publish_beacon(client: &PkarrRelayClient, endpoint: &Endpoint, room_key: &SecretKey) {
    let mut data = EndpointData::default();
    let mut has_relay = false;
    for relay in endpoint.addr().relay_urls() {
        data.add_relay_url(relay.clone());
        has_relay = true;
    }
    if !has_relay {
        return;
    }
    let user_data: UserData = match endpoint.id().to_string().parse() {
        Ok(data) => data,
        Err(_) => return,
    };
    data = data.with_user_data(user_data);
    let info = EndpointInfo::from_parts(room_key.public(), data);
    match info.to_pkarr_signed_packet(room_key, BEACON_TTL) {
        Ok(packet) => {
            if let Err(err) = client.publish(&packet).await {
                debug!("beacon publish failed: {err:#}");
            } else {
                debug!("beacon published (endpoint {})", endpoint.id());
            }
        }
        Err(err) => debug!("beacon packet encoding failed: {err:#}"),
    }
}
