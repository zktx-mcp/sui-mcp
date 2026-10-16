import type { SqliteDatabase } from "../activity/sqliteActivityStoreTypes.js";
import { cardStateSchema, receiptDisplaySchema, type CardRecord, type CardRecordStore } from "./cardSession.js";

type Row = {
  id: string; owner_id: string; token_hash: string; kind: string;
  state: string; reason: string | null; error: string | null; revision: number;
  created_at: string; expires_at: string; input_json: string;
  accepted_input_json: string | null; result_json: string | null; receipt_display_json: string | null;
  scope: NonNullable<CardRecord["scope"]>; operation_id: string | null;
};

export class SqliteCardRecordStore implements CardRecordStore {
  constructor(private readonly db: SqliteDatabase) {}

  hasReviewInput(reviewSessionId: string, ownerId: string, now: Date): boolean {
    return !!this.db.prepare(`SELECT 1 FROM live_read_cards WHERE owner_id=? AND scope='review'
      AND state='ready' AND accepted_input_json IS NULL AND expires_at>?
      AND json_extract(input_json,'$.reviewSessionId')=? LIMIT 1`).get(ownerId, now.toISOString(), reviewSessionId);
  }

  get(id: string): CardRecord | undefined {
    const row = this.db.prepare("SELECT * FROM live_read_cards WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      state: cardStateSchema.parse({ cardId: row.id, kind: row.kind, state: row.state, revision: row.revision,
        createdAt: row.created_at, expiresAt: row.expires_at, input: JSON.parse(row.input_json),
        ...(row.reason === null ? {} : { reason: row.reason }), ...(row.error === null ? {} : { error: row.error }),
        ...(row.result_json === null ? {} : { data: JSON.parse(row.result_json) }) }),
      tokenHash: row.token_hash, ownerId: row.owner_id,
      scope: row.scope, ...(row.operation_id === null ? {} : { operationId: row.operation_id }),
      ...(row.accepted_input_json === null ? {} : { acceptedInput: JSON.parse(row.accepted_input_json) as Record<string, unknown> }),
      ...(row.receipt_display_json === null ? {} : { receiptDisplay: receiptDisplaySchema.parse(JSON.parse(row.receipt_display_json)) })
    };
  }
  evaluate(expected: CardRecord, clock: () => Date): { record: CardRecord; evaluatedAt: string } {
    return this.db.transaction(() => {
      const now = clock();
      let record = this.get(expected.state.cardId);
      if (!record || record.tokenHash !== expected.tokenHash || record.ownerId !== expected.ownerId) throw new Error("Saved card access is unavailable.");
      if (!["connect", "disconnect", "review", "settings"].includes(record.state.kind) && record.state.state === "ready" && Date.parse(record.state.expiresAt) <= now.getTime()) {
        const next: CardRecord = { ...record, state: { ...record.state, state: "closed", reason: "expired", revision: record.state.revision + 1 } };
        if (!this.replace(record, next, now)) throw new Error("Card expiry could not be committed.");
        record = this.get(record.state.cardId)!;
      }
      return { record, evaluatedAt: now.toISOString() };
    }).immediate();
  }
  admit(expected: CardRecord, input: Record<string, unknown>, ownerId: string, clock: () => Date): CardRecord | undefined {
    return this.db.transaction(() => {
      const { record } = this.evaluate(expected, clock);
      if (record.ownerId !== ownerId || record.state.state !== "ready" || record.acceptedInput !== undefined ||
          record.state.revision !== expected.state.revision) return undefined;
      const next: CardRecord = { ...record, acceptedInput: input, state: { ...record.state, input,
        state: "running", revision: record.state.revision + 1 } };
      if (!this.replace(record, next)) throw new Error("Card admission could not be committed.");
      return next;
    }).immediate();
  }
  create(record: CardRecord): void {
    if (record.state.state === "closed") record = this.terminal(record);
    this.db.prepare(`INSERT INTO live_read_cards
      (id, owner_id, token_hash, kind, state, reason, error, revision, created_at, expires_at,
       input_json, accepted_input_json, result_json, receipt_display_json, scope, operation_id)
      VALUES (@id, @owner, @token, @kind, @state, @reason, @error, @revision, @created, @expires,
       @input, @accepted, @result, @display, @scope, @operation)`).run(values(record));
  }
  private terminal(record: CardRecord): CardRecord {
    if (["connect", "disconnect", "review", "settings"].includes(record.state.kind) && record.state.data === undefined) {
      throw new Error("The owning domain must supply the card's committed result.");
    }
    return record;
  }
  replace(expected: CardRecord, next: CardRecord, _at?: Date): boolean {
    if (expected.state.state === "closed") return false;
    return this.db.transaction(() => {
      if (next.state.state === "closed") next = this.terminal(next);
      return this.db.prepare(`UPDATE live_read_cards SET owner_id=@owner,state=@state,reason=@reason,error=@error,
        revision=@revision,input_json=@input,accepted_input_json=@accepted,result_json=@result,
        receipt_display_json=@display,scope=@scope,operation_id=@operation
        WHERE id=@id AND owner_id=@expectedOwner AND token_hash=@token AND revision=@expectedRevision
          AND state=@expectedState`).run({ ...values(next), expectedOwner: expected.ownerId,
            expectedRevision: expected.state.revision, expectedState: expected.state.state }).changes === 1;
    }).immediate();
  }
  recover(ownerId: string, now: Date): void {
    this.db.transaction(() => {
      const ids = this.db.prepare("SELECT id FROM live_read_cards WHERE state!='closed' AND kind NOT IN ('connect','disconnect','review','settings') AND owner_id!=?").all(ownerId) as { id: string }[];
      for (const { id } of ids) {
        const record = this.get(id)!;
        const reason = record.state.state === "ready" && Date.parse(record.state.expiresAt) <= now.getTime() ? "expired" : "server_restarted";
        if (!this.replace(record, { ...record, ownerId, state: { ...record.state, state: "closed", reason, revision: record.state.revision + 1 } }, now)) {
          throw new Error("Card recovery could not be committed.");
        }
      }
    }).immediate();
  }
}

function values(record: CardRecord) {
  const state = cardStateSchema.parse(record.state);
    return { id: state.cardId, owner: record.ownerId, token: record.tokenHash, kind: state.kind,
    scope: record.scope ?? "read", operation: record.operationId ?? null,
    state: state.state, reason: state.reason ?? null, error: state.error ?? null, revision: state.revision,
    created: state.createdAt, expires: state.expiresAt, input: JSON.stringify(state.input),
    accepted: record.acceptedInput === undefined ? null : JSON.stringify(record.acceptedInput),
    result: state.data === undefined ? null : JSON.stringify(state.data),
    display: record.receiptDisplay === undefined ? null : JSON.stringify(receiptDisplaySchema.parse(record.receiptDisplay)) };
}
