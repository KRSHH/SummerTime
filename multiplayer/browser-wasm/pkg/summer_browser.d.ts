/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

/**
 * A joined room: send state via `sender`, read events from `receiver`.
 */
export class RoomChannel {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Leaves the room: drops the gossip subscription on both halves.
     */
    close(): void;
    readonly receiver: ReadableStream;
    readonly sender: RoomSender;
}

/**
 * Broadcasts signed game-state to everyone in the room.
 */
export class RoomSender {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Broadcasts a raw state body (signed + sequenced in Rust).
     */
    broadcast(data: Uint8Array): Promise<void>;
}

/**
 * P2P node for the SummerTime room.
 */
export class SummerNode {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The hex endpoint id of this node (its identity in the room).
     */
    endpoint_id(): string;
    /**
     * Joins the single hardcoded room. The returned channel carries a
     * sender for broadcasting and a ReadableStream of events.
     */
    join_room(): Promise<RoomChannel>;
    /**
     * Spawns the iroh endpoint + gossip protocol.
     */
    static spawn(): Promise<SummerNode>;
}

export function start(): void;
