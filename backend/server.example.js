/* server.example.js — reference backend for the offline-first sync protocol.
 *
 * Zero dependencies (Node >= 18, built-in http). In-memory store. NOT for
 * production: no auth enforcement, no persistence, no real WhatsApp/BSP.
 * Its only job is to make the contract in openapi.yaml concrete and runnable,
 * mirroring the validate()/apply() logic of js/sync.js on the server side.
 *
 *   node backend/server.example.js
 *   curl localhost:3000/v1/availability?fecha=2026-06-22
 */
'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

/* ---------- In-memory store (seeded minimally) ---------- */
const db = {
  patients: new Map(),
  practitioners: new Map(),
  slots: new Map(),
  assessments: new Map(),
  notifications: new Map(),
  conflicts: new Map(),
  processed: new Map() // client_id -> SyncResult (idempotency, §6.3.1)
};

(function seed() {
  const pros = [
    { id: 'P001', nombre: 'Dra. Ana Ruiz', especialidades: ['Oncología'], sede: 'Sede Norte', activo: true },
    { id: 'P002', nombre: 'Dr. Luis Páez', especialidades: ['Geriatría'], sede: 'Sede Norte', activo: true }
  ];
  pros.forEach((p) => db.practitioners.set(p.id, p));
  db.patients.set('c-1', { client_id: 'c-1', id: 'PT001', nombre: 'Rosa Helena Méndez', consentimiento: true, opt_out: false });
  db.patients.set('c-2', { client_id: 'c-2', id: 'PT007', nombre: 'Blanca Estela Niño', consentimiento: true, opt_out: true });
  // A couple of slots for the reservation demo.
  ['08:00', '08:30', '09:00'].forEach((hora) => {
    const id = `P001|2026-06-22|${hora}`;
    db.slots.set(id, {
      id, profesional_id: 'P001', profesional_nombre: 'Dra. Ana Ruiz', especialidad: 'Oncología',
      sede: 'Sede Norte', fecha: '2026-06-22', hora, duracion_min: 30, estado: 'abierto',
      paciente_id: null, paciente_nombre: null, version: 1
    });
  });
})();

const nowISO = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

/* ---------- Validation (mirrors js/sync.js validate) ---------- */
function validate(op) {
  const p = op.payload || {};
  switch (op.op_type) {
    case 'assessment.create':
    case 'patient.create':
    case 'patient.update':
    case 'note.create':
      return { ok: true };

    case 'slot.reserve': {
      const slot = db.slots.get(p.slot_id);
      if (!slot) return { ok: false, conflict: true, reason: 'El cupo ya no existe' };
      if (slot.paciente_id && slot.paciente_id !== p.paciente_id && slot.estado === 'reservado')
        return { ok: false, conflict: true, reason: 'El cupo ya fue tomado por otro usuario' };
      if ((slot.version || 1) !== p.expected_version)
        return { ok: false, conflict: true, reason: 'La agenda cambió (versión distinta); requiere revisión' };
      return { ok: true };
    }

    case 'notification.enqueue': {
      const n = p.notification || {};
      const pat = db.patients.get(n.paciente_client_id);
      if (!pat) return { ok: false, reason: 'Paciente no encontrado' };
      if (!pat.consentimiento) return { ok: false, reason: 'Sin consentimiento vigente (Ley 1581)' };
      if (pat.opt_out) return { ok: false, reason: 'Paciente solicitó no recibir mensajes (opt-out)' };
      if (n.slot_id) {
        const slot = db.slots.get(n.slot_id);
        if (!slot || slot.estado === 'cerrado' || slot.estado === 'bloqueado')
          return { ok: false, reason: 'La cita asociada fue cancelada; no se envía recordatorio' };
      }
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}

/* ---------- Apply (mirrors js/sync.js apply) ---------- */
function apply(op, confirmed_server) {
  const p = op.payload || {};
  switch (op.op_type) {
    case 'assessment.create': {
      const a = Object.assign({}, p.assessment, { estado: 'confirmado', confirmed_server });
      a.clasificacion = classify(a); // server is authoritative on triage
      db.assessments.set(a.client_id, a);
      if (a.clasificacion === 'rojo') escalate(a);
      return a.client_id;
    }
    case 'patient.create':
    case 'patient.update': {
      const pt = Object.assign({}, db.patients.get(p.patient.client_id), p.patient, { estado: 'confirmado' });
      db.patients.set(pt.client_id, pt);
      return pt.client_id;
    }
    case 'slot.reserve': {
      const slot = db.slots.get(p.slot_id);
      slot.estado = 'reservado';
      slot.paciente_id = p.paciente_id;
      slot.paciente_nombre = p.paciente_nombre;
      slot.version = (slot.version || 1) + 1;
      return slot.id;
    }
    case 'notification.enqueue': {
      const n = Object.assign({}, p.notification, { estado: 'enviado', confirmed_server });
      db.notifications.set(n.client_id, n);
      // TODO: here a real backend calls the BSP to send the pre-approved template.
      return n.client_id;
    }
    default:
      return op.client_id;
  }
}

function classify(a) {
  if (a.sintomas_alarma || a.estado_general === 'mal') return 'rojo';
  if (a.estado_general === 'regular' || a.adherencia === 'no' || a.adherencia === 'a_veces') return 'amarillo';
  return 'verde';
}

function escalate(a) {
  // Immediate escalation (§5.3): notify clinical team, page on-call, etc.
  console.log(`[ESCALAMIENTO] Bandera roja: ${a.paciente_nombre || a.paciente_id} -> equipo clínico`);
}

/* ---------- Sync batch (mirrors processOutbox, server side) ---------- */
function syncBatch(operations) {
  const results = [];
  const ordered = [...operations].sort((x, y) => (x.seq || 0) - (y.seq || 0));
  for (const op of ordered) {
    // Idempotency: replay returns the prior result, never re-applies (§6.3.1).
    if (db.processed.has(op.client_id)) { results.push(db.processed.get(op.client_id)); continue; }

    const v = validate(op);
    let result;
    if (v.ok) {
      const confirmed_server = nowISO();
      const server_id = apply(op, confirmed_server);
      result = { client_id: op.client_id, status: 'confirmed', server_id, confirmed_server };
    } else if (v.conflict) {
      const c = { id: uuid(), op_client_id: op.client_id, op_type: op.op_type, reason: v.reason, ts: nowISO(), resuelto: false };
      db.conflicts.set(c.id, c);
      result = { client_id: op.client_id, status: 'conflict', reason: v.reason };
    } else {
      result = { client_id: op.client_id, status: 'rejected', reason: v.reason };
    }
    db.processed.set(op.client_id, result);
    results.push(result);
  }
  return { results, server_time: nowISO() };
}

/* ---------- Availability (mirrors agenda.js computeAvailability) ---------- */
function availability(q) {
  let slots = [...db.slots.values()].filter((s) => s.fecha === q.fecha);
  if (q.especialidad) slots = slots.filter((s) => s.especialidad === q.especialidad);
  if (q.sede) slots = slots.filter((s) => s.sede === q.sede);
  if (q.profesional_id) slots = slots.filter((s) => s.profesional_id === q.profesional_id);
  const byPro = {};
  slots.forEach((s) => { (byPro[s.profesional_id] = byPro[s.profesional_id] || []).push(s); });
  return {
    fecha: q.fecha,
    abiertos: slots.filter((s) => s.estado === 'abierto').length,
    reservados: slots.filter((s) => s.estado === 'reservado').length,
    cerrados: slots.filter((s) => s.estado === 'cerrado' || s.estado === 'bloqueado').length,
    columns: Object.keys(byPro).map((pid) => ({
      practitioner: db.practitioners.get(pid),
      slots: byPro[pid].sort((a, b) => a.hora.localeCompare(b.hora))
    }))
  };
}

/* ---------- HTTP plumbing ---------- */
function send(res, code, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const q = Object.fromEntries(url.searchParams);

  try {
    if (req.method === 'POST' && path === '/v1/sync') {
      const body = await readBody(req);
      if (!Array.isArray(body.operations)) return send(res, 400, { error: 'operations[] requerido' });
      return send(res, 200, syncBatch(body.operations));
    }
    if (req.method === 'GET' && path === '/v1/availability') {
      if (!q.fecha) return send(res, 400, { error: 'fecha requerida (YYYY-MM-DD)' });
      return send(res, 200, availability(q));
    }
    if (req.method === 'GET' && path === '/v1/slots') return send(res, 200, [...db.slots.values()]);
    if (req.method === 'GET' && path === '/v1/patients') return send(res, 200, [...db.patients.values()]);
    if (req.method === 'GET' && path === '/v1/practitioners') return send(res, 200, [...db.practitioners.values()]);
    if (req.method === 'GET' && path === '/v1/conflicts') return send(res, 200, [...db.conflicts.values()].filter((c) => !c.resuelto));

    const m = path.match(/^\/v1\/conflicts\/([^/]+)\/resolve$/);
    if (req.method === 'POST' && m) {
      const body = await readBody(req);
      const c = db.conflicts.get(m[1]);
      if (!c) return send(res, 404, { error: 'Conflicto no encontrado' });
      c.resuelto = true; c.decision = body.decision; c.nota = body.nota || '';
      return send(res, 200, c);
    }

    if (req.method === 'GET' && path === '/') {
      return send(res, 200, { service: 'seguimiento-oncogeriatria', version: '0.1.0', see: '/v1/availability?fecha=2026-06-22' });
    }
    send(res, 404, { error: 'No encontrado', path });
  } catch (e) {
    send(res, 500, { error: 'Error interno', detail: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(`Reference backend escuchando en http://localhost:${PORT}/v1`));

module.exports = server;
