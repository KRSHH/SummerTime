//! Native CLI tester for the SummerTime P2P room.
//!
//! Joins the exact same hardcoded room as the browser build, so it can be
//! used to verify the whole stack (beacon + gossip + relay) from a terminal:
//!
//!     cargo run -p summer-cli --release
//!
//! Run two instances to see them discover each other and exchange messages.
//! Set `IROH_SECRET` to a hex secret to keep a stable identity across runs.

use anyhow::Result;
use iroh::SecretKey;
use n0_future::StreamExt;
use summer_shared::{Event, SummerNode};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

    let secret_key = match std::env::var("IROH_SECRET") {
        Ok(hex) => hex
            .parse()
            .map_err(|err| anyhow::anyhow!("failed to parse IROH_SECRET: {err}"))?,
        Err(_) => {
            let secret_key = SecretKey::generate();
            println!(
                "* new identity; to reuse it across runs set IROH_SECRET={}",
                hex::encode(secret_key.to_bytes())
            );
            secret_key
        }
    };

    let node = SummerNode::spawn(Some(secret_key)).await?;
    println!("* endpoint id: {}", node.endpoint_id());
    println!("* joining the hardcoded SummerTime room ...");

    let (sender, mut receiver) = node.join_room().await?;
    println!("* waiting for peers ...");

    let broadcast = tokio::task::spawn(async move {
        let mut i = 0u64;
        loop {
            let body = format!(
                "hello from summer-cli #{i} @ {}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs()
            )
            .into_bytes();
            match sender.broadcast(body).await {
                Ok(()) => println!("* broadcast #{i}"),
                Err(err) => eprintln!("* broadcast failed: {err:#}"),
            }
            i += 1;
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    });

    while let Some(event) = receiver.try_next().await? {
        match event {
            Event::NeighborUp { endpoint_id } => println!("* neighbor up: {endpoint_id}"),
            Event::NeighborDown { endpoint_id } => println!("* neighbor down: {endpoint_id}"),
            Event::MessageReceived {
                from,
                data,
                sent_timestamp,
            } => println!(
                "* message from {from} (ts {sent_timestamp}): {:?}",
                String::from_utf8_lossy(&data)
            ),
            Event::Lagged => println!("* lagged"),
        }
    }
    broadcast.abort();
    node.shutdown().await;
    Ok(())
}
