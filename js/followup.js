/* followup.js — WhatsApp follow-up flow simulator (Plan §5).
 * Button-driven assessment for an oncogeriatric population: large buttons,
 * one question at a time, "usted" tone, automatic green/amber/red triage with
 * immediate escalation on any alarm symptom (§5.3, no exceptions).
 */
(function () {
  const ALARMA = ['Dolor intenso', 'Fiebre', 'Vómito persistente', 'Caída', 'Dificultad para respirar', 'Sangrado'];

  const state = { patient: null, msgs: [], step: 'idle', draft: null };

  function time() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function bot(text) { state.msgs.push({ who: 'in', text }); }
  function pat(text) { state.msgs.push({ who: 'out', text }); }
  function sys(text) { state.msgs.push({ who: 'system', text }); }

  async function render(view) {
    const patients = await DB.all('patients');
    const recent = (await DB.all('assessments')).sort((a, b) => (b.created_local || b.fecha).localeCompare(a.created_local || a.fecha)).slice(0, 8);
    const eligible = patients.filter((p) => p.consentimiento && !p.opt_out);

    view.innerHTML = `
      <div class="page-head">
        <h1>💬 Seguimiento por WhatsApp</h1>
        <p>Simulador del flujo de valoración con botones. Clasificación automática y escalamiento inmediato de banderas rojas.</p>
      </div>
      <div class="wa-wrap">
        <div>
          <div class="wa-phone">
            <div class="wa-head">
              <div class="wa-avatar">🩺</div>
              <div><strong>Clínica Oncogeriatría</strong><br/><small>${state.patient ? 'con ' + state.patient.nombre : 'cuenta verificada'}</small></div>
            </div>
            <div class="wa-body" id="waBody"></div>
            <div class="wa-actions" id="waActions"></div>
          </div>
          <div class="wa-note">Vista del teléfono del paciente · los botones simulan sus respuestas</div>
        </div>
        <div>
          <div class="card">
            <h3>Iniciar valoración</h3>
            <div class="field">
              <label>Paciente (con consentimiento vigente)</label>
              <select id="fuPat">
                <option value="">Seleccione…</option>
                ${eligible.map((p) => `<option value="${p.client_id}">${p.nombre}</option>`).join('')}
              </select>
            </div>
            <button class="btn" id="fuStart" disabled>Enviar plantilla de seguimiento</button>
            <p class="card-sub" style="margin-top:.6rem">${patients.length - eligible.length} paciente(s) excluido(s) por falta de consentimiento u opt-out.</p>
          </div>
          <div class="card" style="margin-top:1rem">
            <h3>Valoraciones recientes</h3>
            <div class="section-list" id="fuRecent">
              ${recent.length ? recent.map(recentRow).join('') : '<div class="muted-empty">Sin valoraciones aún.</div>'}
            </div>
          </div>
        </div>
      </div>`;

    const sel = view.querySelector('#fuPat');
    const startBtn = view.querySelector('#fuStart');
    sel.onchange = () => { startBtn.disabled = !sel.value; };
    startBtn.onclick = async () => {
      state.patient = await DB.get('patients', sel.value);
      state.msgs = []; state.draft = { sintomas_lista: [] };
      startFlow(view);
    };

    paintPhone(view);
  }

  function recentRow(a) {
    const cls = a.clasificacion === 'rojo' ? 'pill-red' : a.clasificacion === 'amarillo' ? 'pill-amber' : 'pill-green';
    const estado = a.estado === 'pendiente' ? ' <span class="pill pill-amber" style="font-size:.6rem">pendiente sync</span>' : '';
    return `<div class="flow-step" style="border:none;padding:.3rem 0">
      <span class="pill ${cls}" style="font-size:.65rem">${a.clasificacion}</span>
      <div style="flex:1"><strong>${a.paciente_nombre}</strong><br/><small>${a.fecha} · estado ${a.estado_general} · adherencia ${a.adherencia}</small>${estado}</div>
    </div>`;
  }

  function startFlow(view) {
    const nombre = state.patient.nombre.split(' ').slice(0, 2).join(' ');
    bot(`Buenos días, Sr./Sra. ${nombre}. Le escribe la Clínica de Oncogeriatría para su valoración de seguimiento. ¿Puede respondernos ahora?`);
    state.step = 'invite';
    paintPhone(view);
  }

  function actionsFor(step) {
    switch (step) {
      case 'invite': return [
        { label: 'Sí, ahora', val: 'si' },
        { label: 'Más tarde', val: 'tarde' },
        { label: 'Prefiero llamada', val: 'llamada' }
      ];
      case 'q_estado': return [
        { label: '😀 Bien', val: 'bien' },
        { label: '😐 Regular', val: 'regular' },
        { label: '😟 Mal', val: 'mal' }
      ];
      case 'q_alarma': return [
        { label: 'No, ninguno', val: 'no' },
        { label: 'Sí, alguno', val: 'si' }
      ];
      case 'q_alarma_which': return ALARMA.map((s) => ({ label: s, val: s })).concat([{ label: '✓ Terminar selección', val: '__done' }]);
      case 'q_adher': return [
        { label: 'Sí, siempre', val: 'si' },
        { label: 'A veces', val: 'a_veces' },
        { label: 'No', val: 'no' }
      ];
      case 'q_open': return [
        { label: 'No, gracias', val: 'skip' },
        { label: 'Escribir algo más', val: 'write' }
      ];
      default: return [];
    }
  }

  function paintPhone(view) {
    const body = view.querySelector('#waBody');
    const actions = view.querySelector('#waActions');
    if (!body) return;
    body.innerHTML = state.msgs.map((m) => {
      if (m.who === 'system') return `<div class="bubble bubble-system">${m.text}</div>`;
      const cls = m.who === 'in' ? 'bubble-in' : 'bubble-out';
      return `<div class="bubble ${cls}">${m.text}<span class="b-time">${time()}</span></div>`;
    }).join('');
    body.scrollTop = body.scrollHeight;

    const acts = actionsFor(state.step);
    if (state.step === 'idle') {
      actions.innerHTML = '<div class="wa-note">Seleccione un paciente y envíe la plantilla para iniciar.</div>';
    } else if (state.step === 'q_open_write') {
      actions.innerHTML = `<input type="text" id="openTxt" placeholder="Escriba su mensaje…" style="border:1px solid #ccc;border-radius:999px;padding:.55rem .8rem" />
        <button class="wa-btn" id="openSend">Enviar</button>`;
      view.querySelector('#openSend').onclick = () => {
        const t = view.querySelector('#openTxt').value.trim();
        pat(t || '(sin texto)'); state.draft.nota = t; finish(view);
      };
    } else {
      actions.innerHTML = acts.map((a) => `<button class="wa-btn" data-val="${a.val}">${a.label}</button>`).join('');
      actions.querySelectorAll('button[data-val]').forEach((b) => b.onclick = () => handle(b.dataset.val, b.textContent, view));
    }
  }

  function handle(val, label, view) {
    const step = state.step;
    if (step !== 'q_alarma_which') pat(label);

    if (step === 'invite') {
      if (val === 'si') { askEstado(view); return; }
      if (val === 'tarde') {
        bot('Sin problema. Le recordaremos en unas horas. Si prefiere, puede escribirnos cuando guste. 🙏');
        sys('Reintento automático programado en 4 h (máx. 2). Plan §5.2 (2b).');
        state.step = 'done'; paintPhone(view); return;
      }
      if (val === 'llamada') {
        bot('De acuerdo. Una enfermera la llamará hoy entre 2:00 y 4:00 pm desde el número 601-555-0000. Así sabrá que somos nosotros. 📞');
        sys('Ticket creado para enfermería (llamada anunciada, §5.2 2c).');
        state.step = 'done'; paintPhone(view); return;
      }
    }

    if (step === 'q_estado') { state.draft.estado_general = val; askAlarma(view); return; }

    if (step === 'q_alarma') {
      if (val === 'no') { state.draft.sintomas_alarma = false; askAdher(view); return; }
      bot('¿Cuál de estos ha sentido? Puede marcar varios y luego pulsar "Terminar".');
      state.step = 'q_alarma_which'; paintPhone(view); return;
    }

    if (step === 'q_alarma_which') {
      if (val === '__done') {
        state.draft.sintomas_alarma = state.draft.sintomas_lista.length > 0;
        pat(state.draft.sintomas_lista.length ? state.draft.sintomas_lista.join(', ') : 'Ninguno');
        askAdher(view); return;
      }
      const list = state.draft.sintomas_lista;
      const idx = list.indexOf(val);
      if (idx >= 0) list.splice(idx, 1); else list.push(val);
      // Re-render with a hint of current selection.
      const body = view.querySelector('#waBody');
      paintPhone(view);
      // mark selected buttons
      view.querySelectorAll('#waActions button[data-val]').forEach((b) => {
        if (list.includes(b.dataset.val)) { b.style.background = '#0d9488'; b.style.color = '#fff'; }
      });
      return;
    }

    if (step === 'q_adher') { state.draft.adherencia = val; askOpen(view); return; }

    if (step === 'q_open') {
      if (val === 'write') { state.step = 'q_open_write'; paintPhone(view); return; }
      state.draft.nota = ''; finish(view);
    }
  }

  function askEstado(view) { bot('¿Cómo se ha sentido en general estos días?'); state.step = 'q_estado'; paintPhone(view); }
  function askAlarma(view) { bot('¿Ha tenido alguno de estos síntomas de alarma?'); state.step = 'q_alarma'; paintPhone(view); }
  function askAdher(view) { bot('¿Ha podido tomar sus medicamentos como se le indicó?'); state.step = 'q_adher'; paintPhone(view); }
  function askOpen(view) { bot('¿Hay algo más que quiera contarnos? (opcional)'); state.step = 'q_open'; paintPhone(view); }

  function classify(d) {
    if (d.sintomas_alarma || d.estado_general === 'mal') return 'rojo';
    if (d.estado_general === 'regular' || d.adherencia === 'no' || d.adherencia === 'a_veces') return 'amarillo';
    return 'verde';
  }

  async function finish(view) {
    const d = state.draft;
    const clas = classify(d);
    const clinicMsg = {
      verde: 'Gracias por sus respuestas. Todo parece estar en orden. Seguiremos en contacto. 💚',
      amarillo: 'Gracias. Una enfermera revisará sus respuestas hoy y la contactará si es necesario.',
      rojo: '⚠️ Gracias por avisarnos. Sus síntomas requieren atención. Si es una emergencia, llame al 123 o acuda a urgencias ahora. Nuestro equipo la contactará de inmediato.'
    }[clas];
    bot(clinicMsg);
    sys('Recordatorio permanente: si es una emergencia, llame al 123 o acuda a urgencias.');

    const assessment = {
      client_id: DB.uuid(),
      paciente_id: state.patient.id,
      paciente_nombre: state.patient.nombre,
      fecha: new Date().toISOString().slice(0, 10),
      estado_general: d.estado_general,
      sintomas_alarma: !!d.sintomas_alarma,
      sintomas_lista: d.sintomas_lista || [],
      adherencia: d.adherencia,
      nota: d.nota || '',
      clasificacion: clas,
      intervencion_humana: clas !== 'verde',
      estado: 'pendiente',
      created_local: new Date().toISOString(),
      confirmed_server: null
    };
    await DB.put('assessments', assessment);

    // Update patient last-followup.
    state.patient.ultimo_seguimiento = assessment.fecha;
    await DB.put('patients', state.patient);

    // Queue for deferred sync (works offline).
    await Sync.enqueue('assessment.create', { client_id: assessment.client_id }, { label: `Valoración · ${state.patient.nombre.split(' ')[0]} (${clas})` });
    await Sync.enqueue('patient.update', { client_id: state.patient.client_id }, { label: `Actualizar paciente · ${state.patient.nombre.split(' ')[0]}` });

    // Immediate escalation on red flag — no waiting for sync (§5.3).
    if (clas === 'rojo') {
      Bus.emit('alert', { paciente: state.patient.nombre, sintomas: (d.sintomas_lista || []).join(', ') || 'estado general malo' });
      UI.toast(`🔴 BANDERA ROJA · ${state.patient.nombre}: escalado al equipo clínico`, 'red', 6000);
    } else if (clas === 'amarillo') {
      UI.toast(`🟡 ${state.patient.nombre}: a cola de revisión de enfermería`, 'amber');
    } else {
      UI.toast(`🟢 ${state.patient.nombre}: valoración sin alarmas`, 'green');
    }

    state.step = 'done';
    paintPhone(view);
    // Refresh the recent list.
    const recent = (await DB.all('assessments')).sort((a, b) => (b.created_local || b.fecha).localeCompare(a.created_local || a.fecha)).slice(0, 8);
    const cont = view.querySelector('#fuRecent');
    if (cont) cont.innerHTML = recent.map(recentRow).join('');
    Bus.emit('data:change');
  }

  window.FollowUp = { render };
})();
