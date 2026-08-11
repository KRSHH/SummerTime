/* @ts-self-types="./summer_browser.d.ts" */
import * as wasm from "./summer_browser_bg.wasm";
import { __wbg_set_wasm } from "./summer_browser_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    IntoUnderlyingByteSource, IntoUnderlyingSink, IntoUnderlyingSource, RoomChannel, RoomSender, SummerNode, start
} from "./summer_browser_bg.js";
