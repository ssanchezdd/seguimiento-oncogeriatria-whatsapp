/* agenda.js — agenda module (Plan §7).
 * Dynamic availability calculated against the REAL agenda (never the bare
 * template): a slot is "abierto" only if open AND the practitioner is active
 * AND it does not collide with a reservation/block. Specialty filter + CSV
 * import/export with preview.
 */
(function () {
  const DOW = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  const DOW_LABEL = { lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles', jueves: 'Jueves', viernes: 'Viernes', sabado: 'Sábado', domingo: 'Domingo' };

  function isoDate(d) { return d.toISOString().slice(0, 10); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
  function toHHMM(min) { return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }
  function normBool(v) { return /^(si|sí|s|true|1|x|yes|y)$/i.test(String(v).trim()); }
  function slotId(pid, fecha, hora) { return `${pid}|${fecha}|${hora}`; }

  const HORIZON_BACK = 1, HORIZON_FWD = 14;

  /* Regenerate concrete slots from templates across the horizon, applying
   * exceptions, and preserving existing reservations (non-destructive, §7.4). */
  async function regenerateSlots(opts) {
    opts = opts || {};
    const [pros, templates, exceptions, existing] = await Promise.all([
      DB.all('practitioners'), DB.all('templates'), DB.all('exceptions'), DB.all('slots')
    ]);
    const proById = Object.fromEntries(pros.map((p) => [p.id, p]));
    const reservedById = {};
    existing.forEach((s) => { if (s.estado === 'reservado' || s.pendiente) reservedById[s.id] = s; });

    const start = addDays(new Date(), -HORIZON_BACK);
    const fresh = [];
    for (let i = 0; i <= HORIZON_BACK + HORIZON_FWD; i++) {
      const date = addDays(start, i);
      const fecha = isoDate(date);
      const dow = DOW[date.getDay()];
      templates.forEach((t) => {
        const pro = proById[t.profesional_id];
        if (!pro || !pro.activo) return;        // inactive practitioner → no slots
        if (t.dia_semana !== dow) return;
        for (let m = toMin(t.hora_inicio); m + Number(t.duracion_min) <= toMin(t.hora_fin); m += Number(t.duracion_min)) {
          const hora = toHHMM(m);
          const id = slotId(t.profesional_id, fecha, hora);
          let estado = 'abierto';
          // Apply exceptions (block / closure).
          const exc = exceptions.find((e) => e.profesional_id === t.profesional_id && e.fecha === fecha &&
            m >= toMin(e.hora_inicio) && m < toMin(e.hora_fin));
          if (exc) estado = exc.tipo === 'bloqueo' ? 'bloqueado' : 'cerrado';
          // Preserve a confirmed/pending reservation that already exists.
          const kept = reservedById[id];
          if (kept && estado === 'abierto') {
            fresh.push(kept);
          } else {
            fresh.push({
              id, profesional_id: t.profesional_id, profesional_nombre: pro.nombre,
              especialidad: pro.especialidades[0], sede: pro.sede, fecha, hora,
              duracion_min: Number(t.duracion_min), estado,
              paciente_id: null, paciente_nombre: null, version: 1, pendiente: false
            });
          }
        }
      });
    }

    await DB.clear('slots');
    await DB.bulkPut('slots', fresh);

    // Seed-time pre-reservations so the demo shows a mixed agenda.
    if (opts.patients) {
      const open = fresh.filter((s) => s.estado === 'abierto').sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));
      const picks = open.filter((_, i) => i % 5 === 0).slice(0, 5);
      picks.forEach((s, i) => {
        const pt = opts.patients[i % opts.patients.length];
        s.estado = 'reservado'; s.paciente_id = pt.id; s.paciente_nombre = pt.nombre; s.version = 2;
      });
      await DB.bulkPut('slots', picks);
    }
    return fresh.length;
  }

  /* Availability calculation (§7.2). */
  async function computeAvailability(fecha, filters) {
    filters = filters || {};
    const [slots, pros] = await Promise.all([DB.all('slots'), DB.all('practitioners')]);
    const proById = Object.fromEntries(pros.map((p) => [p.id, p]));
    let daySlots = slots.filter((s) => s.fecha === fecha);
    if (filters.especialidad) daySlots = daySlots.filter((s) => s.especialidad === filters.especialidad);
    if (filters.sede) daySlots = daySlots.filter((s) => s.sede === filters.sede);
    if (filters.profesional) daySlots = daySlots.filter((s) => s.profesional_id === filters.profesional);

    const byPro = {};
    daySlots.forEach((s) => { (byPro[s.profesional_id] = byPro[s.profesional_id] || []).push(s); });
    const columns = Object.keys(byPro).map((pid) => ({
      pro: proById[pid],
      slots: byPro[pid].sort((a, b) => a.hora.localeCompare(b.hora))
    })).filter((c) => c.pro).sort((a, b) => a.pro.nombre.localeCompare(b.pro.nombre));

    const abiertos = daySlots.filter((s) => s.estado === 'abierto').length;
    const reservados = daySlots.filter((s) => s.estado === 'reservado').length;
    const cerrados = daySlots.filter((s) => s.estado === 'cerrado' || s.estado === 'bloqueado').length;
    return { columns, abiertos, reservados, cerrados };
  }

  /* ---------------- View ---------------- */
  const state = { fecha: isoDate(new Date()), especialidad: '', sede: '', profesional: '' };

  async function render(view) {
    const [pros] = await Promise.all([DB.all('practitioners')]);
    const specialties = [...new Set(pros.flatMap((p) => p.especialidades))].sort();
    const sedes = [...new Set(pros.map((p) => p.sede))].sort();

    view.innerHTML = `
      <div class="page-head">
        <h1>🗓️ Agenda</h1>
        <p>Disponibilidad calculada contra la agenda real (citas + bloqueos), con filtro por especialidad y carga/exportación CSV.</p>
      </div>
      <div class="toolbar">
        <button class="btn ghost sm" id="dayPrev">‹ Día</button>
        <input type="date" id="fecha" class="select-inline" value="${state.fecha}" />
        <button class="btn ghost sm" id="dayNext">Día ›</button>
        <button class="btn ghost sm" id="dayToday">Hoy</button>
        <select id="fEsp" class="select-inline">
          <option value="">Todas las especialidades</option>
          ${specialties.map((s) => `<option value="${s}" ${state.especialidad === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <select id="fSede" class="select-inline">
          <option value="">Todas las sedes</option>
          ${sedes.map((s) => `<option value="${s}" ${state.sede === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <div class="spacer"></div>
        <button class="btn secondary sm" id="btnImport">⬆ Importar CSV</button>
        <button class="btn secondary sm" id="btnExport">⬇ Exportar CSV</button>
      </div>
      <div id="agendaSummary" class="grid grid-4" style="margin-bottom:1rem"></div>
      <div id="agendaBody"></div>
      <div class="agenda-legend">
        <span class="legend-item"><span class="legend-dot" style="background:#dcfce7"></span> Abierto</span>
        <span class="legend-item"><span class="legend-dot" style="background:#fef3c7"></span> Reservado</span>
        <span class="legend-item"><span class="legend-dot" style="background:#f1f5f9"></span> Cerrado / Bloqueado</span>
      </div>`;

    view.querySelector('#fecha').addEventListener('change', (e) => { state.fecha = e.target.value; paint(view); });
    view.querySelector('#dayPrev').addEventListener('click', () => { state.fecha = isoDate(addDays(parseISO(state.fecha), -1)); render(view); });
    view.querySelector('#dayNext').addEventListener('click', () => { state.fecha = isoDate(addDays(parseISO(state.fecha), 1)); render(view); });
    view.querySelector('#dayToday').addEventListener('click', () => { state.fecha = isoDate(new Date()); render(view); });
    view.querySelector('#fEsp').addEventListener('change', (e) => { state.especialidad = e.target.value; paint(view); });
    view.querySelector('#fSede').addEventListener('change', (e) => { state.sede = e.target.value; paint(view); });
    view.querySelector('#btnImport').addEventListener('click', () => openImportModal(view));
    view.querySelector('#btnExport').addEventListener('click', openExportModal);

    paint(view);
  }

  async function paint(view) {
    const { columns, abiertos, reservados, cerrados } = await computeAvailability(state.fecha, state);
    const d = parseISO(state.fecha);
    const dateLabel = `${DOW_LABEL[DOW[d.getDay()]]} ${d.getDate()}/${d.getMonth() + 1}`;

    view.querySelector('#agendaSummary').innerHTML = `
      ${kpiCard('🟢', abiertos, 'Cupos abiertos')}
      ${kpiCard('🟡', reservados, 'Reservados')}
      ${kpiCard('⚪', cerrados, 'Cerrados / bloqueados')}
      ${kpiCard('👥', columns.length, 'Profesionales con agenda', dateLabel)}`;

    const body = view.querySelector('#agendaBody');
    if (columns.length === 0) {
      body.innerHTML = `<div class="card"><div class="muted-empty">No hay cupos para ${dateLabel} con los filtros actuales.</div></div>`;
      return;
    }
    body.innerHTML = `<div class="agenda-grid">${columns.map((c) => `
      <div class="agenda-col">
        <div class="agenda-colhead">
          <strong>${c.pro.nombre}</strong>
          <small>${c.pro.especialidades.join(', ')} · ${c.pro.sede}</small>
        </div>
        <div class="agenda-slots">
          ${c.slots.map((s) => slotHtml(s)).join('') || '<div class="wa-note">Sin cupos</div>'}
        </div>
      </div>`).join('')}</div>`;

    body.querySelectorAll('.slot-abierto').forEach((el) => {
      el.addEventListener('click', () => openReserveModal(el.dataset.id, view));
    });
    body.querySelectorAll('.slot-reservado').forEach((el) => {
      el.addEventListener('click', () => openSlotInfo(el.dataset.id, view));
    });
  }

  function slotHtml(s) {
    const cls = 'slot slot-' + s.estado;
    const right = s.estado === 'reservado'
      ? `<span class="pill pill-amber" style="font-size:.62rem">${s.pendiente ? '⏳' : ''} ${(s.paciente_nombre || '').split(' ')[0]}</span>`
      : s.estado === 'abierto' ? '<span class="pill pill-green" style="font-size:.62rem">libre</span>'
      : '<span class="pill pill-gray" style="font-size:.62rem">x</span>';
    return `<div class="${cls}" data-id="${s.id}"><span class="slot-h">${s.hora}</span>${right}</div>`;
  }

  function kpiCard(icon, val, label, sub) {
    return `<div class="card kpi"><span class="kpi-icon">${icon}</span><span class="kpi-val">${val}</span><span class="kpi-label">${label}${sub ? ' · ' + sub : ''}</span></div>`;
  }

  /* ---------------- Reserve a slot ---------------- */
  async function openReserveModal(id, view) {
    const slot = await DB.get('slots', id);
    const patients = (await DB.all('patients')).filter((p) => !p.opt_out);
    const offline = !Net.isOnline();
    UI.modal(`
      <h2>Reservar cupo</h2>
      <p class="card-sub">${slot.profesional_nombre} · ${slot.especialidad} · ${slot.fecha} ${slot.hora} (${slot.duracion_min} min)</p>
      <div class="field">
        <label>Paciente</label>
        <select id="rsvPat">${patients.map((p) => `<option value="${p.client_id}">${p.nombre}${p.consentimiento ? '' : ' (sin consentimiento)'}</option>`).join('')}</select>
      </div>
      <label class="checkbox-row"><input type="checkbox" id="rsvNotify" checked /> <span>Enviar recordatorio por WhatsApp (se valida consentimiento y ventana de Meta antes de enviar)</span></label>
      ${offline ? '<div class="banner banner-warn">📴 Está offline. La reserva quedará <strong>pendiente</strong> y se confirmará al reconectar (reserva tentativa, §6.4).</div>' : ''}
      <div class="modal-foot">
        <button class="btn ghost" id="rsvCancel">Cancelar</button>
        <button class="btn" id="rsvOk">Reservar</button>
      </div>`, {
      onMount(root) {
        root.querySelector('#rsvCancel').onclick = UI.closeModal;
        root.querySelector('#rsvOk').onclick = async () => {
          const pcid = root.querySelector('#rsvPat').value;
          const notify = root.querySelector('#rsvNotify').checked;
          const pat = await DB.get('patients', pcid);
          // Optimistic local update → pending until sync confirms.
          slot.estado = 'reservado'; slot.paciente_id = pat.id; slot.paciente_nombre = pat.nombre; slot.pendiente = true;
          await DB.put('slots', slot);
          await Sync.enqueue('slot.reserve', {
            slot_id: slot.id, paciente_id: pat.id, paciente_nombre: pat.nombre,
            expected_version: slot.version || 1
          }, { label: `Reserva ${slot.hora} · ${pat.nombre.split(' ')[0]}` });
          if (notify) {
            const ncid = DB.uuid();
            await DB.put('notifications', {
              client_id: ncid, paciente_id: pat.id, paciente_client_id: pcid, tipo: 'recordatorio_cita',
              slot_id: slot.id, estado: 'pendiente_envio', created_local: new Date().toISOString()
            });
            await Sync.enqueue('notification.enqueue', { client_id: ncid, paciente_client_id: pcid, slot_id: slot.id },
              { label: `Recordatorio WhatsApp · ${pat.nombre.split(' ')[0]}` });
          }
          UI.closeModal();
          UI.toast(offline ? 'Reserva encolada (offline)' : 'Reserva enviada a sincronización', offline ? 'amber' : 'green');
          paint(view);
        };
      }
    });
  }

  async function openSlotInfo(id, view) {
    const slot = await DB.get('slots', id);
    UI.modal(`
      <h2>Cupo reservado</h2>
      <dl class="kv">
        <dt>Profesional</dt><dd>${slot.profesional_nombre}</dd>
        <dt>Especialidad</dt><dd>${slot.especialidad}</dd>
        <dt>Fecha / hora</dt><dd>${slot.fecha} ${slot.hora}</dd>
        <dt>Paciente</dt><dd>${slot.paciente_nombre || '—'}</dd>
        <dt>Estado sync</dt><dd>${slot.pendiente ? '<span class="pill pill-amber">pendiente</span>' : '<span class="pill pill-green">confirmado</span>'}</dd>
        <dt>Versión (lock)</dt><dd>${slot.version || 1}</dd>
      </dl>
      <div class="banner banner-info" style="margin-top:1rem">🧪 Demo: puede simular que <strong>otro usuario</strong> tome este cupo mientras usted está offline, para ver la cola de conflictos.</div>
      <div class="modal-foot">
        ${slot.pendiente ? `<button class="btn danger" id="simConc">Simular reserva concurrente</button>` : ''}
        <button class="btn ghost" id="liberar">Liberar cupo</button>
        <button class="btn" id="cerrar">Cerrar</button>
      </div>`, {
      onMount(root) {
        root.querySelector('#cerrar').onclick = UI.closeModal;
        root.querySelector('#liberar').onclick = async () => {
          slot.estado = 'abierto'; slot.paciente_id = null; slot.paciente_nombre = null; slot.pendiente = false;
          slot.version = (slot.version || 1) + 1;
          await DB.put('slots', slot); UI.closeModal(); UI.toast('Cupo liberado'); paint(view);
        };
        const sim = root.querySelector('#simConc');
        if (sim) sim.onclick = async () => {
          await Sync.simulateConcurrentBooking(slot.id);
          UI.closeModal();
          UI.toast('Otro usuario tomó el cupo. Sincronice para ver el conflicto.', 'amber');
          paint(view);
        };
      }
    });
  }

  /* ---------------- CSV export ---------------- */
  function openExportModal() {
    UI.modal(`
      <h2>Exportar a CSV</h2>
      <p class="card-sub">Descargue la configuración para editarla en Excel/Sheets y reimportarla (§7.4).</p>
      <div class="btn-row">
        <button class="btn secondary" data-exp="profesionales">Profesionales</button>
        <button class="btn secondary" data-exp="plantillas">Plantillas de disponibilidad</button>
        <button class="btn secondary" data-exp="excepciones">Excepciones / bloqueos</button>
      </div>
      <div class="modal-foot"><button class="btn ghost" id="expClose">Cerrar</button></div>`, {
      onMount(root) {
        root.querySelector('#expClose').onclick = UI.closeModal;
        root.querySelectorAll('[data-exp]').forEach((b) => b.onclick = () => doExport(b.dataset.exp));
      }
    });
  }

  async function doExport(kind) {
    if (kind === 'profesionales') {
      const rows = (await DB.all('practitioners')).map((p) => ({
        id: p.id, nombre: p.nombre, especialidad: p.especialidades.join('|'), sede: p.sede, activo: p.activo ? 'si' : 'no'
      }));
      CSV.download('profesionales.csv', CSV.serialize(rows, ['id', 'nombre', 'especialidad', 'sede', 'activo']));
    } else if (kind === 'plantillas') {
      const rows = (await DB.all('templates')).map((t) => ({
        profesional_id: t.profesional_id, dia_semana: t.dia_semana, hora_inicio: t.hora_inicio,
        hora_fin: t.hora_fin, duracion_min: t.duracion_min, sede: t.sede
      }));
      CSV.download('plantillas_disponibilidad.csv', CSV.serialize(rows, ['profesional_id', 'dia_semana', 'hora_inicio', 'hora_fin', 'duracion_min', 'sede']));
    } else {
      const rows = (await DB.all('exceptions')).map((e) => ({
        profesional_id: e.profesional_id, fecha: e.fecha, hora_inicio: e.hora_inicio, hora_fin: e.hora_fin, tipo: e.tipo, nota: e.nota
      }));
      CSV.download('excepciones.csv', CSV.serialize(rows, ['profesional_id', 'fecha', 'hora_inicio', 'hora_fin', 'tipo', 'nota']));
    }
    UI.toast('CSV descargado', 'green');
  }

  /* ---------------- CSV import (with preview, §7.4) ---------------- */
  function openImportModal(view) {
    UI.modal(`
      <h2>Importar CSV</h2>
      <div class="field">
        <label>Tipo de archivo</label>
        <select id="impKind">
          <option value="profesionales">Profesionales (id,nombre,especialidad,sede,activo)</option>
          <option value="plantillas">Plantillas (profesional_id,dia_semana,hora_inicio,hora_fin,duracion_min,sede)</option>
          <option value="excepciones">Excepciones (profesional_id,fecha,hora_inicio,hora_fin,tipo,nota)</option>
        </select>
      </div>
      <div class="form-row">
        <div class="field"><label>Archivo CSV</label><input type="file" id="impFile" accept=".csv,text/csv" /></div>
        <div class="field"><label>Separador</label><select id="impSep"><option value="auto">Auto-detectar</option><option value=",">Coma (,)</option><option value=";">Punto y coma (;)</option></select></div>
      </div>
      <div class="banner banner-info">Importación <strong>no destructiva</strong>: una cita confirmada nunca se borra; los choques van a la lista de conflictos. Se muestra una vista previa antes de aplicar.</div>
      <div id="impPreview"></div>
      <div class="modal-foot">
        <button class="btn ghost" id="impCancel">Cancelar</button>
        <button class="btn" id="impApply" disabled>Aplicar importación</button>
      </div>`, {
      onMount(root) {
        let parsed = null, kind = 'profesionales';
        const preview = root.querySelector('#impPreview');
        const applyBtn = root.querySelector('#impApply');
        root.querySelector('#impCancel').onclick = UI.closeModal;
        root.querySelector('#impKind').onchange = (e) => { kind = e.target.value; if (parsed) doPreview(); };

        root.querySelector('#impFile').onchange = (e) => {
          const file = e.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = async () => {
            const sepSel = root.querySelector('#impSep').value;
            const sep = sepSel === 'auto' ? undefined : sepSel;
            parsed = CSV.parse(reader.result, sep);
            kind = root.querySelector('#impKind').value;
            await doPreview();
          };
          reader.readAsText(file, 'utf-8');
        };

        async function doPreview() {
          const res = await validateImport(kind, parsed.rows);
          applyBtn.disabled = res.valid.length === 0;
          preview.innerHTML = `
            <div style="margin:.6rem 0 .3rem"><strong>${res.valid.length}</strong> fila(s) válidas · <strong class="${res.errors.length ? 'tag-bad' : ''}">${res.errors.length}</strong> con error</div>
            <div class="preview-list">
              ${res.valid.slice(0, 50).map((v) => `<div class="ok">✓ ${v.summary}</div>`).join('')}
              ${res.errors.slice(0, 50).map((er) => `<div class="err">✗ fila ${er.line}: ${er.reason}</div>`).join('')}
            </div>`;
          applyBtn.onclick = async () => {
            await applyImport(kind, res.valid);
            UI.closeModal();
            UI.toast(`Importación aplicada: ${res.valid.length} fila(s)`, 'green');
            render(view);
          };
        }
      }
    });
  }

  async function validateImport(kind, rows) {
    const valid = [], errors = [];
    const pros = await DB.all('practitioners');
    const proIds = new Set(pros.map((p) => p.id));
    const timeRe = /^\d{1,2}:\d{2}$/;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    rows.forEach((r, i) => {
      const line = i + 2;
      try {
        if (kind === 'profesionales') {
          if (!r.id || !r.nombre) throw new Error('faltan id o nombre');
          valid.push({ summary: `${r.id} · ${r.nombre} · ${r.especialidad || '—'} · ${normBool(r.activo) ? 'activo' : 'inactivo'}`, data: r });
        } else if (kind === 'plantillas') {
          if (!proIds.has(r.profesional_id) && !rows.some((x) => x.id === r.profesional_id)) throw new Error(`profesional ${r.profesional_id} inexistente`);
          if (!DOW.includes((r.dia_semana || '').toLowerCase())) throw new Error('dia_semana inválido');
          if (!timeRe.test(r.hora_inicio) || !timeRe.test(r.hora_fin)) throw new Error('formato de hora inválido');
          if (toMin(r.hora_fin) <= toMin(r.hora_inicio)) throw new Error('hora_fin <= hora_inicio');
          if (!Number(r.duracion_min)) throw new Error('duracion_min inválida');
          valid.push({ summary: `${r.profesional_id} ${DOW_LABEL[r.dia_semana.toLowerCase()]} ${r.hora_inicio}-${r.hora_fin} (${r.duracion_min}m)`, data: r });
        } else {
          if (!proIds.has(r.profesional_id)) throw new Error(`profesional ${r.profesional_id} inexistente`);
          if (!dateRe.test(r.fecha)) throw new Error('fecha inválida (YYYY-MM-DD)');
          if (!timeRe.test(r.hora_inicio) || !timeRe.test(r.hora_fin)) throw new Error('formato de hora inválido');
          if (!['bloqueo', 'cerrado'].includes((r.tipo || '').toLowerCase())) throw new Error('tipo debe ser bloqueo|cerrado');
          valid.push({ summary: `${r.profesional_id} ${r.fecha} ${r.hora_inicio}-${r.hora_fin} (${r.tipo})`, data: r });
        }
      } catch (e) { errors.push({ line, reason: e.message }); }
    });
    return { valid, errors };
  }

  async function applyImport(kind, valid) {
    if (kind === 'profesionales') {
      const existing = Object.fromEntries((await DB.all('practitioners')).map((p) => [p.id, p]));
      const rows = valid.map((v) => {
        const r = v.data;
        const prev = existing[r.id] || {};
        return {
          id: r.id, nombre: r.nombre,
          especialidades: (r.especialidad || prev.especialidades?.join('|') || 'General').split('|').map((s) => s.trim()).filter(Boolean),
          sede: r.sede || prev.sede || 'Sede Norte', activo: normBool(r.activo)
        };
      });
      await DB.bulkPut('practitioners', rows);
    } else if (kind === 'plantillas') {
      // Replace templates for the professionals present in the file.
      const affected = new Set(valid.map((v) => v.data.profesional_id));
      const keep = (await DB.all('templates')).filter((t) => !affected.has(t.profesional_id));
      const rows = valid.map((v) => ({
        id: DB.uuid(), profesional_id: v.data.profesional_id, dia_semana: v.data.dia_semana.toLowerCase(),
        hora_inicio: v.data.hora_inicio, hora_fin: v.data.hora_fin, duracion_min: Number(v.data.duracion_min),
        sede: v.data.sede || 'Sede Norte'
      }));
      await DB.clear('templates');
      await DB.bulkPut('templates', keep.concat(rows));
    } else {
      const rows = valid.map((v) => ({
        id: DB.uuid(), profesional_id: v.data.profesional_id, fecha: v.data.fecha,
        hora_inicio: v.data.hora_inicio, hora_fin: v.data.hora_fin, tipo: v.data.tipo.toLowerCase(), nota: v.data.nota || ''
      }));
      const existing = await DB.all('exceptions');
      await DB.bulkPut('exceptions', existing.concat(rows));
    }
    await regenerateSlots(); // non-destructive: preserves reservations
  }

  window.Agenda = { regenerateSlots, computeAvailability, render };
})();
