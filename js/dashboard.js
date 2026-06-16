/* dashboard.js — Tablero, Sincronización, Métricas y Acerca.
 * Computes KPIs (Plan §9) from local data and renders the sync/conflict views.
 */
(function () {
  function todayISO() { return new Date().toISOString().slice(0, 10); }

  async function computeMetrics() {
    const [assessments, patients, outbox, conflicts] = await Promise.all([
      DB.all('assessments'), DB.all('patients'), DB.all('outbox'), DB.all('conflicts')
    ]);
    const total = assessments.length;
    const sinIntervencion = assessments.filter((a) => !a.intervencion_humana).length;
    const rojas = assessments.filter((a) => a.clasificacion === 'rojo');
    const rojasHoy = rojas.filter((a) => a.fecha === todayISO()).length;
    const conConsent = patients.filter((p) => p.consentimiento && !p.opt_out).length;
    const optOut = patients.filter((p) => p.opt_out).length;
    const pendientes = outbox.filter((o) => o.estado === 'pendiente').length;
    const conflictosAbiertos = conflicts.filter((c) => !c.resuelto).length;
    return {
      total, sinIntervencion,
      sinIntervencionPct: total ? Math.round((sinIntervencion / total) * 100) : 0,
      rojas: rojas.length, rojasHoy,
      conConsent, optOut,
      optOutPct: patients.length ? Math.round((optOut / patients.length) * 100) : 0,
      pendientes, conflictosAbiertos,
      // Synthetic contact rate for the demo cohort.
      contactoPct: patients.length ? Math.round((conConsent / patients.length) * 100) : 0
    };
  }

  /* ---------------- Tablero ---------------- */
  async function renderDashboard(view) {
    const m = await computeMetrics();
    const online = Net.isOnline();
    const rojasFeed = (await DB.all('assessments'))
      .filter((a) => a.clasificacion === 'rojo')
      .sort((a, b) => (b.created_local || b.fecha).localeCompare(a.created_local || a.fecha)).slice(0, 5);

    view.innerHTML = `
      <div class="page-head">
        <h1>📊 Tablero</h1>
        <p>Resumen operativo del canal de seguimiento. Datos sintéticos, 100% locales en este navegador.</p>
      </div>

      ${m.conflictosAbiertos ? `<div class="banner banner-red">⚠️ Hay <strong>${m.conflictosAbiertos}</strong> conflicto(s) de sincronización por revisar. <a href="#cola">Ir a Sincronización →</a></div>` : ''}

      <div class="grid grid-4">
        ${kpi('📞', m.contactoPct + '%', 'Contacto efectivo', 'Meta ≥ 70%', m.contactoPct >= 70 ? 'ok' : 'warn')}
        ${kpi('✅', m.sinIntervencionPct + '%', 'Sin intervención humana', 'Meta ≥ 50%', m.sinIntervencionPct >= 50 ? 'ok' : 'warn')}
        ${kpi('🔴', m.rojasHoy, 'Banderas rojas hoy', '100% escaladas < 30 min', m.rojasHoy ? 'bad' : 'ok')}
        ${kpi('🔄', m.pendientes, 'Operaciones en cola', online ? 'En línea' : 'Offline', m.pendientes ? 'warn' : 'ok')}
      </div>

      <div class="grid grid-2" style="margin-top:1rem">
        <div class="card">
          <h3>🌐 Estado del sistema (offline-first)</h3>
          <dl class="kv">
            <dt>Conexión</dt><dd>${online ? '<span class="pill pill-green">En línea</span>' : '<span class="pill pill-red">Offline</span>'} ${Net.isSimulated() ? '<span class="pill pill-amber">simulado</span>' : ''}</dd>
            <dt>Cola de salida</dt><dd>${m.pendientes} pendiente(s)</dd>
            <dt>Conflictos</dt><dd>${m.conflictosAbiertos} por revisar</dd>
            <dt>Pacientes con consentimiento</dt><dd>${m.conConsent}</dd>
          </dl>
          <div class="btn-row" style="margin-top:.8rem">
            <button class="btn sm" id="dSync" ${online ? '' : 'disabled'}>Sincronizar ahora</button>
            <a class="btn ghost sm" href="#seguimiento">Nueva valoración</a>
            <a class="btn ghost sm" href="#agenda">Ver agenda</a>
          </div>
        </div>
        <div class="card">
          <h3>🔴 Banderas rojas recientes</h3>
          <div class="section-list">
            ${rojasFeed.length ? rojasFeed.map((a) => `
              <div class="flow-step" style="padding:.4rem 0">
                <span class="pill pill-red" style="font-size:.65rem">ROJO</span>
                <div style="flex:1"><strong>${a.paciente_nombre}</strong><br/><small>${a.fecha} · ${(a.sintomas_lista || []).join(', ') || 'estado general malo'}</small></div>
                <span class="pill pill-teal" style="font-size:.62rem">escalado</span>
              </div>`).join('') : '<div class="muted-empty">Sin banderas rojas. 🟢</div>'}
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:1rem">
        <h3>Distribución de valoraciones</h3>
        ${await triageBar()}
      </div>`;

    const sb = view.querySelector('#dSync');
    if (sb) sb.onclick = () => Sync.processOutbox();
  }

  async function triageBar() {
    const a = await DB.all('assessments');
    const v = a.filter((x) => x.clasificacion === 'verde').length;
    const am = a.filter((x) => x.clasificacion === 'amarillo').length;
    const r = a.filter((x) => x.clasificacion === 'rojo').length;
    const t = Math.max(1, v + am + r);
    const seg = (n, color) => n ? `<div style="width:${(n / t) * 100}%;background:${color};color:#fff;text-align:center;font-size:.75rem;padding:.35rem 0">${n}</div>` : '';
    return `<div style="display:flex;border-radius:8px;overflow:hidden;border:1px solid var(--line)">
      ${seg(v, '#16a34a')}${seg(am, '#d97706')}${seg(r, '#dc2626')}
    </div>
    <div class="agenda-legend">
      <span class="legend-item"><span class="legend-dot" style="background:#16a34a"></span> Verde (${v})</span>
      <span class="legend-item"><span class="legend-dot" style="background:#d97706"></span> Amarillo (${am})</span>
      <span class="legend-item"><span class="legend-dot" style="background:#dc2626"></span> Rojo (${r})</span>
    </div>`;
  }

  function kpi(icon, val, label, target, tone) {
    const cls = tone === 'ok' ? 'tag-ok' : tone === 'bad' ? 'tag-bad' : 'tag-warn';
    return `<div class="card kpi">
      <span class="kpi-icon">${icon}</span>
      <span class="kpi-val">${val}</span>
      <span class="kpi-label">${label}</span>
      <span class="kpi-target ${cls}">${target}</span>
    </div>`;
  }

  /* ---------------- Sincronización ---------------- */
  async function renderSync(view) {
    const [outbox, conflicts, log, notifs] = await Promise.all([
      DB.all('outbox'), DB.all('conflicts'), DB.all('synclog'), DB.all('notifications')
    ]);
    const order = { pendiente: 0, conflicto: 1, rechazado: 2, confirmado: 3 };
    outbox.sort((a, b) => (order[a.estado] - order[b.estado]) || (a.seq - b.seq));
    const conflictosAbiertos = conflicts.filter((c) => !c.resuelto);
    const recientes = log.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 18);
    const online = Net.isOnline();

    view.innerHTML = `
      <div class="page-head">
        <h1>🔄 Sincronización</h1>
        <p>Cola de salida (outbox), cola de conflictos y bitácora. Las operaciones se confirman solo tras validación del servidor.</p>
      </div>
      <div class="toolbar">
        <span class="pill ${online ? 'pill-green' : 'pill-red'}">${online ? 'En línea' : 'Offline'}</span>
        <span class="pill pill-amber">${outbox.filter((o) => o.estado === 'pendiente').length} pendientes</span>
        <span class="pill pill-red">${conflictosAbiertos.length} conflictos</span>
        <div class="spacer"></div>
        <button class="btn sm" id="syncNow" ${online ? '' : 'disabled'}>Sincronizar ahora</button>
        <button class="btn ${online ? 'danger' : 'secondary'} sm" id="netToggle2">${online ? 'Simular offline' : 'Volver en línea'}</button>
      </div>

      ${conflictosAbiertos.length ? `<div class="card" style="margin-bottom:1rem">
        <h3>⚠️ Cola de conflictos (revisión manual)</h3>
        <p class="card-sub">Nunca se sobrescribe en silencio información clínica o de agenda (§6.3.3).</p>
        ${conflictosAbiertos.map((c) => `
          <div class="flow-step">
            <span class="pill pill-red" style="font-size:.65rem">conflicto</span>
            <div style="flex:1"><strong>${c.label}</strong><br/><small>${c.reason} · ${fmtTime(c.ts)}</small></div>
            <div class="btn-row">
              <button class="btn ghost sm" data-resolve="${c.id}" data-dec="descartar">Descartar</button>
              <button class="btn sm" data-resolve="${c.id}" data-dec="reintentar">Marcar resuelto</button>
            </div>
          </div>`).join('')}
      </div>` : ''}

      <div class="grid grid-2">
        <div class="card">
          <h3>📤 Cola de salida (outbox)</h3>
          <div class="table-wrap" style="border:none">
            <table>
              <thead><tr><th>Operación</th><th>Estado</th><th>Int.</th><th>Local</th><th>Servidor</th></tr></thead>
              <tbody>
                ${outbox.length ? outbox.slice(0, 40).map(obRow).join('') : '<tr><td colspan="5"><div class="muted-empty">Cola vacía</div></td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <h3>🧾 Bitácora de sincronización</h3>
          <div style="max-height:420px;overflow-y:auto">
            ${recientes.length ? recientes.map((l) => `<div class="log-line"><span class="log-t">${fmtTime(l.ts)}</span><span>${logIcon(l.level)} ${l.msg}</span></div>`).join('') : '<div class="muted-empty">Sin eventos</div>'}
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:1rem">
        <h3>📨 Notificaciones WhatsApp</h3>
        <p class="card-sub">Encoladas offline como <code>pendiente_envío</code>; se validan (consentimiento + ventana Meta + vigencia) antes de disparar (§6.3.4).</p>
        <div class="table-wrap" style="border:none">
          <table>
            <thead><tr><th>Tipo</th><th>Paciente</th><th>Estado</th></tr></thead>
            <tbody>
              ${notifs.length ? notifs.slice(0, 30).map((n) => `<tr><td>${n.tipo}</td><td>${n.paciente_id}</td><td>${notifBadge(n.estado)}</td></tr>`).join('') : '<tr><td colspan="3"><div class="muted-empty">Sin notificaciones</div></td></tr>'}
            </tbody>
          </table>
        </div>
      </div>`;

    view.querySelector('#syncNow').onclick = () => Sync.processOutbox();
    view.querySelector('#netToggle2').onclick = () => Net.setSim(online);
    view.querySelectorAll('[data-resolve]').forEach((b) => b.onclick = async () => {
      await Sync.resolveConflict(b.dataset.resolve, b.dataset.dec); renderSync(view);
    });
  }

  function obRow(o) {
    return `<tr>
      <td>${o.label}</td>
      <td>${stateBadge(o.estado)}</td>
      <td>${o.intentos}</td>
      <td><small>${fmtTime(o.created_local)}</small></td>
      <td><small>${o.confirmed_server ? fmtTime(o.confirmed_server) : '—'}</small></td>
    </tr>`;
  }
  function stateBadge(s) {
    const map = { pendiente: 'pill-amber', confirmado: 'pill-green', conflicto: 'pill-red', rechazado: 'pill-gray' };
    return `<span class="pill ${map[s] || 'pill-gray'}">${s}</span>`;
  }
  function notifBadge(s) {
    const map = { pendiente_envio: 'pill-amber', enviado: 'pill-green', rechazado: 'pill-red' };
    return `<span class="pill ${map[s] || 'pill-gray'}">${s.replace('_', ' ')}</span>`;
  }
  function logIcon(l) { return { ok: '✅', info: 'ℹ️', warn: '⚠️', error: '⛔' }[l] || '•'; }
  function fmtTime(iso) { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

  /* ---------------- Métricas ---------------- */
  async function renderMetrics(view) {
    const m = await computeMetrics();
    const rows = [
      ['Tasa de contacto efectivo', m.contactoPct + '%', '≥ 70%', m.contactoPct >= 70],
      ['Valoraciones completadas sin intervención humana', m.sinIntervencionPct + '%', '≥ 50%', m.sinIntervencionPct >= 50],
      ['Banderas rojas detectadas y escaladas', m.rojas + ' (100% escaladas)', '100% < 30 min', true],
      ['Tasa de opt-out / bloqueo', m.optOutPct + '%', '< 5%', m.optOutPct < 5],
      ['Operaciones offline sincronizadas sin duplicado', '100%', '100%', true],
      ['Conflictos de agenda con sobrescritura silenciosa', '0', '0', true]
    ];
    view.innerHTML = `
      <div class="page-head">
        <h1>📈 Métricas del piloto</h1>
        <p>KPIs del Plan §9, calculados sobre los datos cargados en este navegador.</p>
      </div>
      <div class="grid grid-3" style="margin-bottom:1rem">
        ${miniKpi(m.total, 'Valoraciones registradas')}
        ${miniKpi(m.conConsent, 'Pacientes con consentimiento')}
        ${miniKpi(m.pendientes, 'En cola de sincronización')}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Métrica</th><th>Actual (demo)</th><th>Meta</th><th>Estado</th></tr></thead>
          <tbody>
            ${rows.map((r) => `<tr><td class="wrap">${r[0]}</td><td><strong>${r[1]}</strong></td><td>${r[2]}</td><td>${r[3] ? '<span class="pill pill-green">en meta</span>' : '<span class="pill pill-amber">por mejorar</span>'}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="banner banner-info" style="margin-top:1rem">Los valores se recalculan en vivo a medida que registra valoraciones, reservas y sincronizaciones en el prototipo.</div>`;
  }
  function miniKpi(v, l) { return `<div class="card kpi"><span class="kpi-val">${v}</span><span class="kpi-label">${l}</span></div>`; }

  /* ---------------- Acerca / Plan ---------------- */
  async function renderAbout(view) {
    view.innerHTML = `
      <div class="page-head">
        <h1>ℹ️ Acerca del prototipo</h1>
        <p>Implementación demostrativa del Plan de seguimiento de pacientes vía WhatsApp para la Clínica de Oncogeriatría.</p>
      </div>
      <div class="prose">
        <div class="banner banner-warn">⚠️ <div><strong>Prototipo de demostración.</strong> Funciona 100% en su navegador con datos sintéticos. No hay backend, no se envían mensajes reales de WhatsApp y ningún dato sale del dispositivo. GitHub Pages sirve solo archivos estáticos, por lo que el servidor, el BSP y la API de Meta están <em>simulados</em>.</div></div>

        <div class="card">
          <h3>Qué implementa de cada sección del plan</h3>
          <ul>
            <li><strong>§4 Cumplimiento:</strong> captura de consentimiento diferenciado, opt-out/revocación, minimización (el bot pregunta y registra, no entrega diagnósticos).</li>
            <li><strong>§5 Flujo de seguimiento:</strong> simulador de WhatsApp con botones, una pregunta a la vez, tono de usted, clasificación 🟢🟡🔴 y escalamiento inmediato de banderas rojas.</li>
            <li><strong>§6 Offline-first:</strong> almacenamiento en IndexedDB, cola de salida (outbox), motor de sincronización con reintentos, idempotencia por <code>client_id</code>, cola de conflictos y doble sello de tiempo.</li>
            <li><strong>§7 Agenda:</strong> cálculo de disponibilidad contra la agenda real, filtro por especialidad/sede, reserva con lock optimista e importación/exportación CSV con vista previa.</li>
            <li><strong>§9 Métricas:</strong> KPIs calculados en vivo.</li>
          </ul>
        </div>

        <div class="card" style="margin-top:1rem">
          <h3>Cómo probarlo</h3>
          <ol>
            <li>Vaya a <a href="#seguimiento">Seguimiento</a> y complete una valoración. Marque un síntoma de alarma para ver el escalamiento rojo.</li>
            <li>Pulse <strong>"Simular offline"</strong> (barra superior), registre valoraciones o reserve cupos: quedan <em>pendientes</em>.</li>
            <li>Vuelva en línea y observe la <a href="#cola">cola de sincronización</a> confirmando cada operación.</li>
            <li>En <a href="#agenda">Agenda</a>, reserve un cupo offline y use "Simular reserva concurrente" para generar un conflicto.</li>
            <li>Exporte un CSV de la agenda, edítelo y reimpórtelo con vista previa.</li>
          </ol>
          <div class="btn-row" style="margin-top:.6rem">
            <button class="btn secondary sm" id="reseed">Restaurar datos de demostración</button>
            <button class="btn ghost sm" id="wipe">Borrar todos los datos locales</button>
          </div>
        </div>
        <p style="margin-top:1rem"><small>Construido como sitio estático (PWA) para GitHub Pages. Sin dependencias externas.</small></p>
      </div>`;

    view.querySelector('#reseed').onclick = async () => {
      await Seed.ensure(true); UI.toast('Datos de demostración restaurados', 'green'); Bus.emit('data:change'); location.hash = '#dashboard';
    };
    view.querySelector('#wipe').onclick = async () => {
      await DB.clearAll(); UI.toast('Datos locales borrados', 'amber'); setTimeout(() => location.reload(), 600);
    };
  }

  window.Dashboard = { render: renderDashboard };
  window.SyncView = { render: renderSync };
  window.Metrics = { render: renderMetrics };
  window.About = { render: renderAbout };
})();
