// P2P multiplayer transport for SummerTime, built on iroh-gossip compiled
// to WebAssembly. Replaces the old MicroRealm WebSocket relay (and its
// private server) with direct peer-to-peer messaging.
//
// Everyone joins one hardcoded room — no rooms, no join codes, no backend:
//  - A fixed 32-byte seed doubles as the gossip TopicId and as the room's
//    rendezvous key on the public pkarr relay (dns.iroh.link). Every client
//    publishes its endpoint address under that key and resolves it
//    periodically, so peers discover each other and the gossip swarm
//    self-connects.
//  - Traffic flows peer-to-peer over iroh. Browsers cannot hole-punch (no
//    UDP), so packets are relayed through n0's free public relays — still
//    end-to-end encrypted, and no application server is involved.
//  - State frames are signed (ed25519) and sequenced in Rust, so only
//    authenticated messages are surfaced here.
//
// The wasm side exposes: SummerNode.spawn() → node.join_room() →
// { sender, receiver } where sender.broadcast(bytes) signs + broadcasts and
// receiver is a ReadableStream of typed events. State encoding (26 bytes):
//
//   [0]        u8  version (1)
//   [1..13]    p   3 × f32 LE
//   [13..21]   r   2 × f32 LE
//   [21]       u8  a (animation: 0 idle, 1 run, 2 bored)
//   [22..26]   seed f32 LE

import { SummerNode, type RoomChannel } from 'summer-iroh';

export type P2PData = Record<string, number[] | number | string | boolean | null>;

export interface P2PClientData {
  p: number[];
  r: number[];
  a: number;
  seed?: number;
  [key: string]: any;
}

interface P2POptions {
  data: P2PData;
  updateRate?: number;
  addClient?: (id: string, data: P2PClientData) => void;
  removeClient?: (id: string) => void;
  removeAllClients?: () => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

const STATE_VERSION = 1;
const STATE_BYTES = 26;
/** Remove remotes that stopped sending this long ago (they left or hid). */
const REMOTE_TIMEOUT_MS = 10_000;
/** Full-state heartbeat: newcomers can always bootstrap from us. */
const HEARTBEAT_MS = 2_000;
/** While the tab is hidden, keep presence alive at a slow rate. */
const HIDDEN_RATE_MS = 1_000;

type MessageEvent = {
  type: 'messageReceived';
  from: string;
  // serde-wasm-bindgen delivers Vec<u8> as a plain JS Array; normalize in
  // `toBytes` so both shapes are accepted.
  data: Uint8Array | number[];
  sentTimestamp: number;
};
type NeighborUpEvent = { type: 'neighborUp'; endpointId: string };
type NeighborDownEvent = { type: 'neighborDown'; endpointId: string };
type LaggedEvent = { type: 'lagged' };
type P2PEvent = MessageEvent | NeighborUpEvent | NeighborDownEvent | LaggedEvent;

const noop = () => {};

export class P2PConnection {
  _clients = new Map<string, P2PClientData>();
  _data: P2PData;
  private _lastSeen = new Map<string, number>();
  private _updateRate: number;
  private _prevData = '{}';
  private _lastFullSent = 0;
  private _connected = false;
  private _node: SummerNode | null = null;
  private _channel: RoomChannel | null = null;
  private _reader: ReadableStreamDefaultReader<P2PEvent> | null = null;
  private _closed = false;

  private _relayInterval: ReturnType<typeof setInterval> | null = null;
  private _sweepInterval: ReturnType<typeof setInterval> | null = null;
  private _retryTimeout: ReturnType<typeof setTimeout> | null = null;

  private _onAddClient: (id: string, data: P2PClientData) => void;
  private _onRemoveClient: (id: string) => void;
  private _onRemoveAllClients: () => void;
  private _onConnect: () => void;
  private _onDisconnect: () => void;

  constructor(options: P2POptions) {
    this._data = options.data;
    this._updateRate = options.updateRate ?? 35;
    this._onAddClient = options.addClient ?? noop;
    this._onRemoveClient = options.removeClient ?? noop;
    this._onRemoveAllClients = options.removeAllClients ?? noop;
    this._onConnect = options.onConnect ?? noop;
    this._onDisconnect = options.onDisconnect ?? noop;
    this._onRemoveAllClients();
    void this._init();
  }

  /** Spawns the iroh node and joins the room; retries until it succeeds. */
  private async _init() {
    try {
      const node = await SummerNode.spawn();
      this._node = node;
      const channel = await node.join_room();
      if (this._closed) return;
      this._channel = channel;
      this._reader = channel.receiver.getReader() as ReadableStreamDefaultReader<P2PEvent>;

      this._connected = true;
      this._onConnect();
      this._relay(true);
      void this._readLoop();
      this._relayInterval = setInterval(() => this._relay(), this._updateRate);
      this._sweepInterval = setInterval(() => this._sweep(), 1000);
      console.info(`[p2p] joined room as ${node.endpoint_id()}`);
    } catch (err) {
      console.warn('[p2p] join failed, retrying in 5s', err);
      this._teardown();
      if (!this._closed) {
        this._retryTimeout = setTimeout(() => void this._init(), 5000);
      }
    }
  }

  /** Consumes the event stream and applies remote state. */
  private async _readLoop() {
    const reader = this._reader;
    if (!reader) return;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this._onEvent(value);
      }
    } catch (err) {
      if (!this._closed) console.warn('[p2p] event stream closed', err);
    }
  }

  private _onEvent(event: P2PEvent) {
    switch (event.type) {
      case 'messageReceived': {
        const from = event.from;
        if (from === this._node?.endpoint_id()) return; // never echo ourselves
        let state: P2PClientData;
        try {
          state = decodeState(toBytes(event.data));
        } catch (err) {
          console.warn('[p2p] undecodable state', err);
          return;
        }
        this._lastSeen.set(from, Date.now());
        const existing = this._clients.get(from);
        if (existing) {
          for (const key of Object.keys(state)) {
            if (Array.isArray(state[key]) && state[key].length === 0) continue;
            existing[key] = state[key];
          }
        } else {
          this._clients.set(from, { ...this._data, ...state });
          this._onAddClient(from, { ...this._data, ...state });
        }
        return;
      }
      case 'neighborDown': {
        const id = event.endpointId;
        if (!this._clients.has(id)) return;
        this._clients.delete(id);
        this._lastSeen.delete(id);
        this._onRemoveClient(id);
        return;
      }
      case 'neighborUp':
      case 'lagged':
        return;
    }
  }

  /** Publishes local state: full state on join, on change, or as heartbeat. */
  private _relay(force = false) {
    if (!this._connected || !this._channel) return;
    const now = Date.now();
    const hidden = document.hidden;
    const heartbeatElapsed = now - this._lastFullSent >= (hidden ? HIDDEN_RATE_MS : HEARTBEAT_MS);
    if (force || heartbeatElapsed) {
      this._prevData = JSON.stringify(this._data);
      this._lastFullSent = now;
      this._send(this._data);
      return;
    }
    const changed = this._retrieveChangedData();
    if (Object.keys(changed).length > 0) {
      this._prevData = JSON.stringify(this._data);
      this._lastFullSent = now;
      this._send(this._data);
    }
  }

  private _retrieveChangedData(): P2PData {
    const prev = JSON.parse(this._prevData) as P2PData;
    const changed: P2PData = {};
    for (const key of Object.keys(this._data)) {
      if (JSON.stringify(prev[key]) !== JSON.stringify(this._data[key])) {
        changed[key] = this._data[key];
      }
    }
    return changed;
  }

  private _send(data: P2PData) {
    const payload = encodeState(data);
    void this._channel!.sender.broadcast(payload);
  }

  /** Drops remotes that stopped sending (they left or went idle-hidden). */
  private _sweep() {
    const now = Date.now();
    for (const [id, lastSeen] of this._lastSeen) {
      if (now - lastSeen > REMOTE_TIMEOUT_MS) {
        this._lastSeen.delete(id);
        if (this._clients.has(id)) {
          this._clients.delete(id);
          this._onRemoveClient(id);
        }
      }
    }
  }

  private _teardown() {
    if (this._relayInterval) clearInterval(this._relayInterval);
    if (this._sweepInterval) clearInterval(this._sweepInterval);
    this._relayInterval = null;
    this._sweepInterval = null;
    if (this._connected) {
      this._connected = false;
      this._onDisconnect();
    }
    this._reader?.cancel().catch(() => {});
    this._channel?.close();
    this._reader = null;
    this._channel = null;
  }

  _dispose() {
    this._closed = true;
    if (this._retryTimeout) clearTimeout(this._retryTimeout);
    this._teardown();
  }
}

// ---------------------------------------------------------------------------
// State codec
// ---------------------------------------------------------------------------

/** Normalizes the event payload (plain Array from serde-wasm-bindgen) to bytes. */
function toBytes(data: Uint8Array | number[]): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function encodeState(data: P2PData): Uint8Array {
  const out = new Uint8Array(STATE_BYTES);
  const view = new DataView(out.buffer);
  out[0] = STATE_VERSION;
  const p = (data.p as number[]) ?? [0, 0, 0];
  const r = (data.r as number[]) ?? [0, 0];
  for (let i = 0; i < 3; i++) view.setFloat32(1 + i * 4, p[i] ?? 0, true);
  for (let i = 0; i < 2; i++) view.setFloat32(13 + i * 4, r[i] ?? 0, true);
  out[21] = (data.a as number) ?? 0;
  view.setFloat32(22, (data.seed as number) ?? 0, true);
  return out;
}

function decodeState(bytes: Uint8Array): P2PClientData {
  if (bytes.length < STATE_BYTES || bytes[0] !== STATE_VERSION) {
    throw new Error(`bad state frame: ${bytes.length} bytes, version ${bytes[0]}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    p: [view.getFloat32(1, true), view.getFloat32(5, true), view.getFloat32(9, true)],
    r: [view.getFloat32(13, true), view.getFloat32(17, true)],
    a: bytes[21],
    seed: view.getFloat32(22, true),
  };
}
