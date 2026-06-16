/* patients.js — patient registry + consent management (Plan §4, §5.1).
 * Captures consent (Ley 1581), caregiver contact, and opt-out/revocation.
 */
(function () {
  async function render(view) {
    const patients = (await DB.all('patients')).sort((a, b) => a.nombre.localeCompare(b.nombre));
    const conSent = patients.filter((p) => p.consentimiento && !p.opt_out).length;

    view.innerHTML = `
      <div class="page-head">
        <h1>👥 Pacientes</h1>
        <p>Registro con consentimiento informado, contacto del cuidador y revocación (opt-out). Datos sensibles bajo Ley 1581.</p>
      </div>
      <div class="toolbar">
        <span class="pill pill-teal">${patients.length} pacientes</span>
        <span class="pill pill-green">${conSent} con consentimiento activo</span>
        <span class="pill pill-gray">${patients.length - conSent} sin canal WhatsApp</span>
        <div class="spacer"></div>
        <button class="btn" id="btnNew">+ Nuevo paciente</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>ID</th><th>Nombre</th><th>Teléfono</th><th class="wrap">Cuidador</th>
            <th>Consentimiento</th><th>Último seguimiento</th><th>Acciones</th>
          </tr></thead>
          <tbody>
            ${patients.map(rowHtml).join('')}
          </tbody>
        </table>
      </div>`;

    view.querySelector('#btnNew').onclick = () => openEdit(null, view);
    view.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openEdit(b.dataset.edit, view));
    view.querySelectorAll('[data-consent]').forEach((b) => b.onclick = () => openConsent(b.dataset.consent, view));
    view.querySelectorAll('[data-optout]').forEach((b) => b.onclick = () => toggleOptOut(b.dataset.optout, view));
  }

  function rowHtml(p) {
    const consent = p.opt_out
      ? '<span class="pill pill-gray">opt-out</span>'
      : p.consentimiento ? `<span class="pill pill-green">sí · ${p.consent_fecha || ''}</span>` : '<span class="pill pill-red">pendiente</span>';
    return `<tr>
      <td>${p.id}</td>
      <td><strong>${p.nombre}</strong>${p.estado === 'pendiente' ? ' <span class="pill pill-amber" style="font-size:.6rem">pend. sync</span>' : ''}</td>
      <td>${p.telefono_paciente}</td>
      <td class="wrap">${p.cuidador || '<small>—</small>'}</td>
      <td>${consent}</td>
      <td>${p.ultimo_seguimiento || '<small>—</small>'}</td>
      <td>
        <button class="btn ghost sm" data-edit="${p.client_id}">Editar</button>
        ${!p.consentimiento && !p.opt_out ? `<button class="btn sm" data-consent="${p.client_id}">Capturar consentimiento</button>` : ''}
        <button class="btn ghost sm" data-optout="${p.client_id}">${p.opt_out ? 'Reactivar' : 'Opt-out'}</button>
      </td>
    </tr>`;
  }

  async function openEdit(clientId, view) {
    const p = clientId ? await DB.get('patients', clientId) : {
      client_id: null, id: '', nombre: '', telefono_paciente: '', cuidador: '', consentimiento: false, opt_out: false
    };
    const isNew = !clientId;
    UI.modal(`
      <h2>${isNew ? 'Nuevo paciente' : 'Editar paciente'}</h2>
      <div class="field"><label>Nombre completo</label><input id="pNombre" value="${esc(p.nombre)}" /></div>
      <div class="form-row">
        <div class="field"><label>Teléfono del paciente</label><input id="pTel" value="${esc(p.telefono_paciente)}" placeholder="+57 3xx xxx xxxx" /></div>
        <div class="field"><label>ID interno</label><input id="pId" value="${esc(p.id)}" placeholder="PT0xx" /></div>
      </div>
      <div class="field"><label>Cuidador (contacto alternativo o principal)</label><input id="pCuid" value="${esc(p.cuidador || '')}" placeholder="Relación: Nombre +57 ..." /></div>
      ${isNew ? `<label class="checkbox-row"><input type="checkbox" id="pConsent" /> <span>Consentimiento informado capturado en consulta (Ley 1581 / Ley 527). Documento diferenciado, no cláusula en letra pequeña.</span></label>` : ''}
      <div class="modal-foot">
        <button class="btn ghost" id="pCancel">Cancelar</button>
        <button class="btn" id="pSave">Guardar</button>
      </div>`, {
      onMount(root) {
        root.querySelector('#pCancel').onclick = UI.closeModal;
        root.querySelector('#pSave').onclick = async () => {
          const nombre = root.querySelector('#pNombre').value.trim();
          if (!nombre) { UI.toast('El nombre es obligatorio', 'amber'); return; }
          const rec = Object.assign({}, p, {
            client_id: p.client_id || DB.uuid(),
            id: root.querySelector('#pId').value.trim() || ('PT' + Date.now().toString().slice(-4)),
            nombre,
            telefono_paciente: root.querySelector('#pTel').value.trim(),
            cuidador: root.querySelector('#pCuid').value.trim(),
            estado: 'pendiente'
          });
          if (isNew) {
            const consent = root.querySelector('#pConsent').checked;
            rec.consentimiento = consent;
            rec.consent_fecha = consent ? new Date().toISOString().slice(0, 10) : null;
            rec.opt_out = false;
          }
          await DB.put('patients', rec);
          await Sync.enqueue(isNew ? 'patient.create' : 'patient.update', { client_id: rec.client_id }, { label: `${isNew ? 'Alta' : 'Edición'} paciente · ${nombre.split(' ')[0]}` });
          UI.closeModal();
          UI.toast(isNew ? 'Paciente creado (en cola de sync)' : 'Paciente actualizado', 'green');
          render(view);
        };
      }
    });
  }

  async function openConsent(clientId, view) {
    const p = await DB.get('patients', clientId);
    UI.modal(`
      <h2>Captura de consentimiento</h2>
      <div class="banner banner-info">Autorización expresa, previa e informada para el tratamiento de datos de salud por el canal WhatsApp (§4). Registra fecha, hora y número.</div>
      <dl class="kv">
        <dt>Paciente</dt><dd>${p.nombre}</dd>
        <dt>Teléfono</dt><dd>${p.telefono_paciente}</dd>
        <dt>Cuidador</dt><dd>${p.cuidador || '—'}</dd>
      </dl>
      <label class="checkbox-row" style="margin-top:1rem"><input type="checkbox" id="c1" /> <span>Autoriza recibir mensajes de seguimiento por WhatsApp y el tratamiento de sus datos de salud por este canal.</span></label>
      <label class="checkbox-row"><input type="checkbox" id="c2" /> <span>Se le informó que es un sistema automatizado, cómo contactar a un humano y cómo revocar ("ESCRIBA SALIR").</span></label>
      <div class="modal-foot">
        <button class="btn ghost" id="cCancel">Cancelar</button>
        <button class="btn" id="cSave" disabled>Registrar consentimiento</button>
      </div>`, {
      onMount(root) {
        const c1 = root.querySelector('#c1'), c2 = root.querySelector('#c2'), save = root.querySelector('#cSave');
        const upd = () => { save.disabled = !(c1.checked && c2.checked); };
        c1.onchange = upd; c2.onchange = upd;
        root.querySelector('#cCancel').onclick = UI.closeModal;
        save.onclick = async () => {
          p.consentimiento = true; p.opt_out = false;
          p.consent_fecha = new Date().toISOString().slice(0, 10);
          p.consent_ts = new Date().toISOString();
          p.estado = 'pendiente';
          await DB.put('patients', p);
          await Sync.enqueue('patient.update', { client_id: p.client_id }, { label: `Consentimiento · ${p.nombre.split(' ')[0]}` });
          UI.closeModal(); UI.toast('Consentimiento registrado', 'green'); render(view);
        };
      }
    });
  }

  async function toggleOptOut(clientId, view) {
    const p = await DB.get('patients', clientId);
    p.opt_out = !p.opt_out;
    p.estado = 'pendiente';
    await DB.put('patients', p);
    await Sync.enqueue('patient.update', { client_id: p.client_id }, { label: `${p.opt_out ? 'Opt-out' : 'Reactivación'} · ${p.nombre.split(' ')[0]}` });
    UI.toast(p.opt_out ? 'Paciente marcado opt-out (vuelve a canal telefónico)' : 'Paciente reactivado', p.opt_out ? 'amber' : 'green');
    render(view);
  }

  function esc(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  window.Patients = { render };
})();
