/* sync.js — offline-first engine (Plan §6).
 * Bus  : tiny pub/sub so views react to data changes.
 * Net  : connection state (navigator.onLine + simulated outage + ping).
 * Sync : outbox queue, server validation, idempotency, conflict queue,
 *        double timestamp, retry with backoff.
 *
 * The "server" is simulated in the browser, but the protocol mirrors a real
 * deferred-sync backend: nothing is "confirmado" until validation passes.
 */
(function () {
  /* ---------- Bus ---------- */
  const handlers = {};
  const Bus = {
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return () => Bus.off(ev, fn); },
    off(ev, fn) { if (handlers[ev]) handlers[ev] = handlers[ev].filter((f) => f !== fn); },
    emit(ev, data) { (handlers[ev] || []).forEach((f) => { try { f(data); } catch (e) { console.error(e); } }); }
  };

  /* ---------- Net ---------- */
  let simOffline = false;
  const Net = {
    async init() { simOffline = (await DB.flag('simOffline')) === true; this.broadcast(); },
    isOnline() { return navigator.onLine && !simOffline; },
    isSimulated() { return simOffline; },
    async setSim(v) { simOffline = !!v; await DB.flag('simOffline', simOffline); this.broadcast(); if (this.isOnline()) Sync.processOutbox(); },
    // §6.2: navigator.onLine is not enough — confirm the backend actually answers.
    async ping() {
      if (!this.isOnline()) return false;
      await wait(120);
      return navigator.onLine && !simOffline;
    },
    broadcast() { Bus.emit('net:change', { online: this.isOnline(), simulated: simOffline }); }
  };

  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function nowISO() { return new Date().toISOString(); }

  async function log(level, msg) {
    const row = { id: DB.uuid(), ts: nowISO(), level, msg };
    await DB.put('synclog', row);
    Bus.emit('synclog:change', row);
  }

  /* ---------- Sync ---------- */
  let processing = false;

  const Sync = {
    /* Enqueue an operation into the outbox (§6.1). Each op carries a unique
     * client_id (UUID) for idempotency (§6.3.1) and a created_local stamp so
     * ops replay in creation order (§6.3.2). */
    async enqueue(op_type, payload, opts) {
      opts = opts || {};
      const op = {
        client_id: DB.uuid(),
        seq: Date.now(),
        op_type,
        payload,
        label: opts.label || op_type,
        estado: 'pendiente',
        intentos: 0,
        created_local: nowISO(),
        confirmed_server: null,
        motivo: null
      };
      await DB.put('outbox', op);
      await log('info', `Encolada operación «${op.label}» (${Net.isOnline() ? 'en línea' : 'offline'})`);
      Bus.emit('outbox:change');
      if (Net.isOnline()) this.processOutbox();
      return op;
    },

    async pending() {
      const all = await DB.all('outbox');
      return all.filter((o) => o.estado === 'pendiente').sort((a, b) => a.seq - b.seq);
    },

    async pendingCount() { return (await this.pending()).length; },

    /* Drain the outbox in order, with backoff. Stops if the network drops
     * mid-run; remaining ops stay pendiente until the next reconnection. */
    async processOutbox(opts) {
      opts = opts || {};
      if (processing) return;
      processing = true;
      Bus.emit('sync:start');
      try {
        const online = await Net.ping();
        if (!online) { await log('warn', 'Sin conexión: la cola permanece pendiente'); return; }

        const queue = await this.pending();
        if (queue.length === 0) { return; }
        await log('info', `Sincronizando ${queue.length} operación(es)…`);

        for (const op of queue) {
          if (!(await Net.ping())) { await log('warn', 'Conexión perdida durante la sincronización'); break; }
          await wait(opts.fast ? 80 : 260); // simulated latency
          op.intentos += 1;

          const result = await validate(op);
          if (result.ok) {
            op.estado = 'confirmado';
            op.confirmed_server = nowISO(); // §6.3.5 double timestamp
            await DB.put('outbox', op);
            await apply(op);
            await log('ok', `✓ Confirmada «${op.label}»`);
          } else if (result.conflict) {
            op.estado = 'conflicto';
            op.motivo = result.reason;
            await DB.put('outbox', op);
            await DB.put('conflicts', {
              id: DB.uuid(), op_client_id: op.client_id, op_type: op.op_type,
              label: op.label, reason: result.reason, ts: nowISO(), payload: op.payload, resuelto: false
            });
            await log('error', `⚠ Conflicto en «${op.label}»: ${result.reason}`);
            Bus.emit('conflict:new');
          } else {
            // Rejected by validation (e.g. consent withdrawn) — not a conflict.
            op.estado = 'rechazado';
            op.motivo = result.reason;
            await DB.put('outbox', op);
            await log('warn', `✗ Rechazada «${op.label}»: ${result.reason}`);
          }
          Bus.emit('outbox:change');
          Bus.emit('data:change');
        }
        await log('info', 'Sincronización finalizada');
      } finally {
        processing = false;
        Bus.emit('sync:end');
        Bus.emit('outbox:change');
      }
    },

    /* Demo helper: simulate another user grabbing a slot before our offline
     * reservation syncs, to exercise the conflict path (§6.3.3). */
    async simulateConcurrentBooking(slotId) {
      const slot = await DB.get('slots', slotId);
      if (!slot) return;
      slot.version = (slot.version || 1) + 1;
      slot.estado = 'reservado';
      slot.paciente_id = 'OTRO';
      slot.paciente_nombre = 'Otro usuario';
      await DB.put('slots', slot);
      await log('warn', `Otro usuario reservó ${slot.hora} de ${slot.profesional_id} mientras estaba offline`);
      Bus.emit('data:change');
    },

    async resolveConflict(conflictId, decision) {
      const c = await DB.get('conflicts', conflictId);
      if (!c) return;
      c.resuelto = true; c.decision = decision;
      await DB.put('conflicts', c);
      await log('info', `Conflicto «${c.label}» resuelto manualmente: ${decision}`);
      Bus.emit('conflict:new'); Bus.emit('data:change');
    }
  };

  /* ---------- Server-side validation (simulated) ---------- */
  async function validate(op) {
    switch (op.op_type) {
      case 'assessment.create':
      case 'patient.create':
      case 'patient.update':
      case 'note.create':
        return { ok: true };

      case 'slot.reserve': {
        // §6.3.3: optimistic lock by version. If the slot moved on, conflict.
        const slot = await DB.get('slots', op.payload.slot_id);
        if (!slot) return { ok: false, conflict: true, reason: 'El cupo ya no existe' };
        if (slot.paciente_id && slot.paciente_id !== op.payload.paciente_id && slot.estado === 'reservado') {
          return { ok: false, conflict: true, reason: 'El cupo ya fue tomado por otro usuario' };
        }
        if ((slot.version || 1) !== op.payload.expected_version) {
          return { ok: false, conflict: true, reason: 'La agenda cambió (versión distinta); requiere revisión' };
        }
        return { ok: true };
      }

      case 'notification.enqueue': {
        // §6.3.4: validate consent + Meta window/template + vigencia BEFORE sending.
        const p = await DB.get('patients', op.payload.paciente_client_id);
        if (!p) return { ok: false, reason: 'Paciente no encontrado' };
        if (!p.consentimiento) return { ok: false, reason: 'Sin consentimiento vigente (Ley 1581)' };
        if (p.opt_out) return { ok: false, reason: 'Paciente solicitó no recibir mensajes (opt-out)' };
        if (op.payload.slot_id) {
          const slot = await DB.get('slots', op.payload.slot_id);
          if (!slot || slot.estado === 'cerrado' || slot.estado === 'bloqueado') {
            return { ok: false, reason: 'La cita asociada fue cancelada; no se envía recordatorio' };
          }
        }
        // Meta template category Utility assumed pre-approved.
        return { ok: true };
      }
      default:
        return { ok: true };
    }
  }

  /* ---------- Apply confirmed op to local state ---------- */
  async function apply(op) {
    switch (op.op_type) {
      case 'assessment.create': {
        const a = await DB.get('assessments', op.payload.client_id);
        if (a) { a.estado = 'confirmado'; a.confirmed_server = op.confirmed_server; await DB.put('assessments', a); }
        break;
      }
      case 'patient.create':
      case 'patient.update': {
        const p = await DB.get('patients', op.payload.client_id);
        if (p) { p.estado = 'confirmado'; await DB.put('patients', p); }
        break;
      }
      case 'slot.reserve': {
        const slot = await DB.get('slots', op.payload.slot_id);
        if (slot) {
          slot.estado = 'reservado';
          slot.paciente_id = op.payload.paciente_id;
          slot.paciente_nombre = op.payload.paciente_nombre;
          slot.version = (slot.version || 1) + 1;
          slot.pendiente = false;
          await DB.put('slots', slot);
        }
        break;
      }
      case 'notification.enqueue': {
        const n = await DB.get('notifications', op.payload.client_id);
        if (n) { n.estado = 'enviado'; n.confirmed_server = op.confirmed_server; await DB.put('notifications', n); }
        break;
      }
    }
  }

  // React to real browser connectivity changes.
  window.addEventListener('online', () => { Net.broadcast(); Sync.processOutbox(); });
  window.addEventListener('offline', () => Net.broadcast());

  window.Bus = Bus;
  window.Net = Net;
  window.Sync = Sync;
})();
