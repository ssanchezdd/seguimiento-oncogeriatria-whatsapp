/* smoke.test.js — exercises the reference server's sync contract.
 * Starts server.example.js in-process and asserts the key guarantees.
 *   node smoke.test.js
 */
'use strict';
process.env.PORT = process.env.PORT || '3939';
const server = require('./server.example.js');

const BASE = `http://localhost:${process.env.PORT}/v1`;
let failures = 0;
function ok(cond, label) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++; }
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (p) => fetch(BASE + p).then((r) => r.json());

(async () => {
  await new Promise((r) => setTimeout(r, 150)); // let the server bind

  // 1. assessment.create with alarm -> server recalculates clasificacion = rojo
  let r = await post('/sync', { operations: [{
    client_id: 'op-asm', seq: 1, op_type: 'assessment.create', created_local: '2026-06-16T10:00:00Z',
    payload: { assessment: { client_id: 'a-1', paciente_id: 'PT001', paciente_nombre: 'Rosa', fecha: '2026-06-16', estado_general: 'bien', sintomas_alarma: true, adherencia: 'si' } }
  }] });
  ok(r.results[0].status === 'confirmed', 'assessment.create confirmed');
  const a1 = await get('/slots'); // touch an endpoint
  ok(Array.isArray(a1), 'GET /slots returns array');

  // 2. Idempotency: same client_id twice -> same result, no duplicate
  const op = { client_id: 'op-dup', seq: 2, op_type: 'patient.update', created_local: '2026-06-16T10:01:00Z', payload: { patient: { client_id: 'c-1', nombre: 'Rosa Helena Méndez' } } };
  const r1 = await post('/sync', { operations: [op] });
  const r2 = await post('/sync', { operations: [op] });
  ok(r1.results[0].status === 'confirmed' && r2.results[0].status === 'confirmed', 'idempotent replay still confirmed');
  ok(r1.results[0].confirmed_server === r2.results[0].confirmed_server, 'idempotent replay returns same confirmed_server (not re-applied)');

  // 3. slot.reserve happy path
  const rr = await post('/sync', { operations: [{
    client_id: 'op-resv1', seq: 3, op_type: 'slot.reserve', created_local: '2026-06-16T10:02:00Z',
    payload: { slot_id: 'P001|2026-06-22|08:00', paciente_id: 'PT001', paciente_nombre: 'Rosa', expected_version: 1 }
  }] });
  ok(rr.results[0].status === 'confirmed', 'slot.reserve confirmed on matching version');

  // 4. slot.reserve conflict: stale expected_version on the now-v2 slot
  const rc = await post('/sync', { operations: [{
    client_id: 'op-resv2', seq: 4, op_type: 'slot.reserve', created_local: '2026-06-16T10:03:00Z',
    payload: { slot_id: 'P001|2026-06-22|08:00', paciente_id: 'PT099', paciente_nombre: 'Otro', expected_version: 1 }
  }] });
  ok(rc.results[0].status === 'conflict', 'slot.reserve -> conflict on stale version');
  const conflicts = await get('/conflicts');
  ok(conflicts.length >= 1, 'conflict appears in GET /conflicts');

  // 5. notification.enqueue rejected for opt-out patient
  const rn = await post('/sync', { operations: [{
    client_id: 'op-notif', seq: 5, op_type: 'notification.enqueue', created_local: '2026-06-16T10:04:00Z',
    payload: { notification: { client_id: 'n-1', paciente_client_id: 'c-2', tipo: 'recordatorio_cita' } }
  }] });
  ok(rn.results[0].status === 'rejected' && /opt-out/i.test(rn.results[0].reason), 'notification rejected for opt-out patient');

  // 6. availability endpoint
  const av = await get('/availability?fecha=2026-06-22');
  ok(typeof av.abiertos === 'number' && Array.isArray(av.columns), 'availability returns counts + columns');

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exitCode = failures === 0 ? 0 : 1;
  server.close(); // let the event loop drain and exit cleanly
})().catch((e) => { console.error(e); process.exitCode = 1; server.close(); });
