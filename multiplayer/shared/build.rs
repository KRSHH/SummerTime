//! Sets the `wasm_browser` cfg alias so the crate can branch on
//! wasm32-unknown-unknown (browser) vs native builds, same as iroh does.

fn main() {
    cfg_aliases::cfg_aliases! {
        wasm_browser: { all(target_arch = "wasm32", target_os = "unknown") },
    }
}
