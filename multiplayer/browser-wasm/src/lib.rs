//! wasm-bindgen wrapper exposing the SummerTime P2P room to TypeScript.
//!
//! API surface (see the generated `pkg/*.d.ts`):
//!   - `SummerNode.spawn()`        → node (connects to relays on bind)
//!   - `node.endpoint_id()`        → hex id of this node
//!   - `node.join_room()`          → `RoomChannel` for the single room
//!   - `channel.sender.broadcast(bytes)` → signed gossip broadcast
//!   - `channel.receiver`          → ReadableStream of `Event` objects
//!   - `channel.close()`           → leave the room

use anyhow::Result;
use n0_future::StreamExt;
use summer_shared::{RoomSender as SharedSender, SummerNode as SharedNode};
use tracing::level_filters::LevelFilter;
use tracing_subscriber_wasm::MakeConsoleWriter;
use wasm_bindgen::{JsError, JsValue, prelude::wasm_bindgen};
use wasm_streams::ReadableStream;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
    tracing_subscriber::fmt()
        .with_max_level(LevelFilter::DEBUG)
        .with_writer(
            // Keep trace events in the browser from printing a JS backtrace.
            MakeConsoleWriter::default().map_trace_level_to(tracing::Level::DEBUG),
        )
        .without_time()
        .with_ansi(false)
        .init();
    tracing::info!("summertime p2p wasm initialized");
}

/// P2P node for the SummerTime room.
#[wasm_bindgen]
pub struct SummerNode(SharedNode);

#[wasm_bindgen]
impl SummerNode {
    /// Spawns the iroh endpoint + gossip protocol.
    pub async fn spawn() -> Result<SummerNode, JsError> {
        let inner = SharedNode::spawn(None).await.map_err(to_js_err)?;
        Ok(SummerNode(inner))
    }

    /// The hex endpoint id of this node (its identity in the room).
    pub fn endpoint_id(&self) -> String {
        self.0.endpoint_id().to_string()
    }

    /// Joins the single hardcoded room. The returned channel carries a
    /// sender for broadcasting and a ReadableStream of events.
    pub async fn join_room(&self) -> Result<RoomChannel, JsError> {
        let (sender, receiver) = self.0.join_room().await.map_err(to_js_err)?;
        let receiver = receiver.map(move |event| {
            event
                .map_err(|err| JsValue::from(err.to_string()))
                .map(|event| serde_wasm_bindgen::to_value(&event).expect("serialize event"))
        });
        let stream = ReadableStream::from_stream(receiver).into_raw();
        Ok(RoomChannel {
            sender: RoomSender(sender),
            receiver: Some(stream.clone()),
            stream,
        })
    }
}

type ChannelStream = wasm_streams::readable::sys::ReadableStream;

/// A joined room: send state via `sender`, read events from `receiver`.
#[wasm_bindgen]
pub struct RoomChannel {
    sender: RoomSender,
    receiver: Option<ChannelStream>,
    stream: ChannelStream,
}

#[wasm_bindgen]
impl RoomChannel {
    #[wasm_bindgen(getter)]
    pub fn sender(&self) -> RoomSender {
        self.sender.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn receiver(&mut self) -> ChannelStream {
        self.stream.clone()
    }

    /// Leaves the room: drops the gossip subscription on both halves.
    pub fn close(&mut self) {
        self.receiver.take();
    }
}

/// Broadcasts signed game-state to everyone in the room.
#[wasm_bindgen]
#[derive(Clone)]
pub struct RoomSender(SharedSender);

#[wasm_bindgen]
impl RoomSender {
    /// Broadcasts a raw state body (signed + sequenced in Rust).
    pub async fn broadcast(&self, data: Vec<u8>) -> Result<(), JsError> {
        self.0.broadcast(data).await.map_err(to_js_err)?;
        Ok(())
    }
}

fn to_js_err(err: impl Into<anyhow::Error>) -> JsError {
    JsError::new(&err.into().to_string())
}
