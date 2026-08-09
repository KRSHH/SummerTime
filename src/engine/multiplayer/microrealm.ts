// Realm multiplayer connection. Clean port of the original
// MicroRealmConnection protocol:
//
//  - Text messages: JSON handshake ({id,t} → {r:[prefix,room,last]}),
//    "ping"/"pong" keepalive, {leave:id} notifications.
//  - Binary messages: 2-byte little-endian client id + protobuf-encoded
//    client state (field numbers assigned by insertion order of `data`).
//
// A minimal proto3 wire codec is implemented here (varint / fixed32 /
// length-delimited) — no protobuf dependency needed.

export type RealmData = Record<string, number[] | number | string | boolean | null>;

export interface RealmClientData {
  p: number[];
  r: number[];
  a: number;
  [key: string]: any;
}

interface RealmOptions {
  servers: string[];
  roomPrefix?: string;
  roomRequested?: string;
  data: RealmData;
  dataTypesOverwrite?: Record<string, string>;
  updateRate?: number;
  pingRate?: number;
  inactiveDisconnect?: boolean;
  inactiveDisconnectTime?: number;
  addClient?: (id: string, data: RealmClientData) => void;
  removeClient?: (id: string) => void;
  removeAllClients?: () => void;
  onRoomJoined?: (room: string) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

// ---------------------------------------------------------------------------
// Minimal proto3 wire-format codec
// ---------------------------------------------------------------------------

const WIRE_VARINT = 0;
const WIRE_FIXED32 = 5;
const WIRE_LENGTH_DELIMITED = 2;

function writeVarint(out: number[], value: number): void {
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

function writeFloat(out: number[], value: number): void {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setFloat32(0, value, true);
  for (let i = 0; i < 4; i++) out.push(buf.getUint8(i));
}

function encodeMessage(
  data: RealmData,
  fieldTypes: Record<string, string>,
): Uint8Array {
  const out: number[] = [];
  const keys = Object.keys(data);
  keys.forEach((name, index) => {
    const value = data[name];
    const field = index + 1;
    const type = fieldTypes[name] ?? '';
    if (type === 'float' && Array.isArray(value)) {
      // packed repeated float
      const floats = value as number[];
      writeVarint(out, (field << 3) | WIRE_LENGTH_DELIMITED);
      writeVarint(out, floats.length * 4);
      for (const f of floats) writeFloat(out, f);
    } else if (type === 'uint32' && typeof value === 'number') {
      writeVarint(out, (field << 3) | WIRE_VARINT);
      writeVarint(out, value);
    } else if (typeof value === 'number') {
      writeVarint(out, (field << 3) | WIRE_FIXED32);
      writeFloat(out, value);
    } else if (Array.isArray(value)) {
      // packed repeated float (default)
      const floats = value as number[];
      writeVarint(out, (field << 3) | WIRE_LENGTH_DELIMITED);
      writeVarint(out, floats.length * 4);
      for (const f of floats) writeFloat(out, f);
    } else if (typeof value === 'string') {
      const bytes = new TextEncoder().encode(value);
      writeVarint(out, (field << 3) | WIRE_LENGTH_DELIMITED);
      writeVarint(out, bytes.length);
      for (const b of bytes) out.push(b);
    }
  });
  return new Uint8Array(out);
}

function decodeMessage(
  bytes: Uint8Array,
  fields: string[],
): RealmClientData {
  const result: RealmClientData = { p: [], r: [], a: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  while (pos < bytes.length) {
    // tag (varint)
    let shift = 0;
    let tag = 0;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      tag |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    const field = tag >>> 3;
    const wire = tag & 0x7;
    const name = fields[field - 1];
    if (!name) {
      // skip unknown field
      if (wire === WIRE_VARINT) {
        while (pos < bytes.length) {
          if ((bytes[pos++] & 0x80) === 0) break;
        }
      } else if (wire === WIRE_FIXED32) {
        pos += 4;
      } else if (wire === WIRE_LENGTH_DELIMITED) {
        let lenShift = 0;
        let len = 0;
        while (pos < bytes.length) {
          const b = bytes[pos++];
          len |= (b & 0x7f) << lenShift;
          if ((b & 0x80) === 0) break;
          lenShift += 7;
        }
        pos += len;
      }
      continue;
    }
    if (wire === WIRE_LENGTH_DELIMITED) {
      let lenShift = 0;
      let len = 0;
      while (pos < bytes.length) {
        const b = bytes[pos++];
        len |= (b & 0x7f) << lenShift;
        if ((b & 0x80) === 0) break;
        lenShift += 7;
      }
      // packed floats
      const count = len / 4;
      const arr: number[] = [];
      for (let i = 0; i < count; i++) {
        arr.push(view.getFloat32(pos, true));
        pos += 4;
      }
      result[name] = arr;
    } else if (wire === WIRE_FIXED32) {
      result[name] = view.getFloat32(pos, true);
      pos += 4;
    } else if (wire === WIRE_VARINT) {
      let vShift = 0;
      let v = 0;
      while (pos < bytes.length) {
        const b = bytes[pos++];
        v |= (b & 0x7f) << vShift;
        if ((b & 0x80) === 0) break;
        vShift += 7;
      }
      result[name] = v >>> 0;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const noop = () => {};

export class RealmConnection {
  _clients = new Map<string, RealmClientData>();
  _data: RealmData;
  private _dataTypes: Record<string, string>;
  private _servers: string[];
  private _roomPrefix: string;
  private _roomRequested: string;
  private _roomLast = '';
  private _updateRate: number;
  private _pingRate: number;
  private _prevData = '{}';
  private _connected = false;
  private _socket!: WebSocket;
  private _pingInterval: ReturnType<typeof setInterval> | null = null;
  private _relayInterval: ReturnType<typeof setInterval> | null = null;
  private _retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private _serverIndex = 0;
  private _serverFirstConnection = true;

  private _onAddClient: (id: string, data: RealmClientData) => void;
  private _onRemoveClient: (id: string) => void;
  private _onRemoveAllClients: () => void;
  private _onRoomJoined: (room: string) => void;
  private _onConnect: () => void;
  private _onDisconnect: () => void;

  constructor(options: RealmOptions) {
    this._servers = options.servers;
    this._roomPrefix = options.roomPrefix ?? 'default';
    this._roomRequested = options.roomRequested ?? '';
    this._data = options.data;
    this._dataTypes = options.dataTypesOverwrite ?? {};
    this._updateRate = options.updateRate ?? 35;
    this._pingRate = options.pingRate ?? 30;
    void options.inactiveDisconnect;
    void options.inactiveDisconnectTime;
    this._onAddClient = options.addClient ?? noop;
    this._onRemoveClient = options.removeClient ?? noop;
    this._onRemoveAllClients = options.removeAllClients ?? noop;
    this._onRoomJoined = options.onRoomJoined ?? noop;
    this._onConnect = options.onConnect ?? noop;
    this._onDisconnect = options.onDisconnect ?? noop;
    this._createSocket();
  }

  private _createSocket() {
    this._socket = new WebSocket(this._servers[this._serverIndex], 'permessage-deflate');
    this._socket.binaryType = 'arraybuffer';
    this._socket.onopen = this._onOpen;
    this._socket.onmessage = this._onMessage;
    this._socket.onerror = this._onClose;
    this._socket.onclose = this._onClose;
  }

  private _onOpen = () => {
    this._serverFirstConnection = false;
    this._connected = true;
    this._onConnect();
  };

  private _onClose = () => {
    this._socket.onopen = null;
    this._socket.onmessage = null;
    this._socket.onclose = null;
    this._socket.onerror = null;
    if (this._pingInterval) clearInterval(this._pingInterval);
    if (this._relayInterval) clearInterval(this._relayInterval);
    if (this._retryTimeout) clearTimeout(this._retryTimeout);
    this._socket.close();
    if (this._connected) {
      this._connected = false;
      this._onDisconnect();
    }
    if (this._serverFirstConnection) {
      this._serverIndex = (this._serverIndex + 1) % this._servers.length;
    }
    this._retryTimeout = setTimeout(() => this._createSocket(), 1000);
  };

  private _onMessage = (e: MessageEvent) => {
    try {
      if (typeof e.data !== 'string') {
        // binary: 2-byte client id + protobuf state
        const bytes = new Uint8Array(e.data as ArrayBuffer);
        const clientId = bytes[0] | (bytes[1] << 8);
        const state = decodeMessage(bytes.slice(2), Object.keys(this._data));
        const existing = this._clients.get(String(clientId));
        if (existing) {
          for (const key of Object.keys(state)) {
            if (Array.isArray(state[key]) && state[key].length === 0) continue;
            existing[key] = state[key];
          }
        } else {
          // full state required before adding a client
          const nonEmpty = Object.keys(state).filter(
            (k) => !(Array.isArray(state[k]) && state[k].length === 0),
          ).length;
          if (nonEmpty !== Object.keys(this._data).length) return;
          this._relay(true);
          this._clients.set(String(clientId), state);
          this._onAddClient(String(clientId), state);
        }
        return;
      }
      if (e.data === 'pong') return;
      const msg = JSON.parse(e.data);
      if (msg.id && typeof msg.id === 'string') {
        void msg.id;
        this._requestRoom();
      } else if (msg.r && typeof msg.r === 'string') {
        this._onRemoveAllClients();
        this._clients.clear();
        this._roomLast = msg.r;
        this._pingInterval ??= setInterval(() => this._socket.send('ping'), this._pingRate * 1000);
        this._relayInterval ??= setInterval(() => this._relay(), this._updateRate);
            this._relay(true);
        this._onRoomJoined(this._roomLast);
      } else if (msg.leave && typeof msg.leave === 'string') {
        if (!this._clients.has(msg.leave)) return;
        this._clients.delete(msg.leave);
        this._onRemoveClient(msg.leave);
      }
    } catch (err) {
      console.log('websocket error', err);
    }
  };

  private _requestRoom() {
    this._socket.send(
      JSON.stringify({ r: [this._roomPrefix, this._roomRequested, this._roomLast] }),
    );
  }

  private _retrieveChangedData(): RealmData {
    const prev = JSON.parse(this._prevData) as RealmData;
    const changed: RealmData = {};
    for (const key of Object.keys(this._data)) {
      if (JSON.stringify(prev[key]) !== JSON.stringify(this._data[key])) {
        changed[key] = this._data[key];
      }
    }
    return changed;
  }

  private _relay(force = false) {
    if (force) {
      this._prevData = JSON.stringify(this._data);
      this._sendRelayedData({ ...this._data });
      return;
    }
    const changed = this._retrieveChangedData();
    if (Object.keys(changed).length > 0) {
      this._prevData = JSON.stringify(this._data);
      this._sendRelayedData(changed);
    }
  }

  private _sendRelayedData(data: RealmData) {
    // protobuf payload only — the server prepends the 2-byte sender id
    const payload = encodeMessage(data, this._dataTypes);
    this._socket.send(payload);
  }

  _dispose() {
    this._socket.onopen = null;
    this._socket.onmessage = null;
    this._socket.onclose = null;
    this._socket.onerror = null;
    if (this._pingInterval) clearInterval(this._pingInterval);
    if (this._relayInterval) clearInterval(this._relayInterval);
    if (this._retryTimeout) clearTimeout(this._retryTimeout);
    this._socket.close();
  }
}
