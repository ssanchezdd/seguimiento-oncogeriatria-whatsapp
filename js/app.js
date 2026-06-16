/* app.js — bootstrap, UI helpers (toast/modal), hash router, top-bar wiring. */
(function () {
  /* ---------- UI helpers ---------- */
  const UI = {
    toast(msg, kind, ms) {
      const t = document.createElement('div');
      t.className = 'toast' + (kind ? ' toast-' + kind : '');
      t.textContent = msg;
      document.getElementById('toasts').appendChild(t);
      setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, ms || 3200);
    },
    modal(html, opts) {
      opts = opts || {};
      const root = document.getElementById('modalRoot');
      root.innerHTML = `<div class="modal-overlay"><div class="modal">${html}</div></div>`;
      const overlay = root.querySelector('.modal-overlay');
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) UI.closeModal(); });
      if (opts.onMount) opts.onMount(root.querySelector('.modal'));
    },
    closeModal() { document.getElementById('modalRoot').innerHTML = ''; }
  };
  window.UI = UI;

  /* ---------- Router ---------- */
  const routes = {
    dashboard: (v) => Dashboard.render(v),
    seguimiento: (v) => FollowUp.render(v),
    agenda: (v) => Agenda.render(v),
    pacientes: (v) => Patients.render(v),
    cola: (v) => SyncView.render(v),
    metricas: (v) => Metrics.render(v),
    acerca: (v) => About.render(v)
  };

  function currentRoute() {
    const h = (location.hash || '#dashboard').replace('#', '');
    return routes[h] ? h : 'dashboard';
  }

  async function navigate() {
    const route = currentRoute();
    const view = document.getElementById('view');
    document.querySelectorAll('.nav-link').forEach((l) => l.classList.toggle('active', l.dataset.route === route));
    closeSidebar();
    view.innerHTML = '<div class="loading">Cargando…</div>';
    try {
      await routes[route](view);
    } catch (e) {
      console.error(e);
      view.innerHTML = `<div class="banner banner-red">Error al renderizar la vista: ${e.message}</div>`;
    }
  }

  /* ---------- Top bar wiring ---------- */
  function updateNetUI(stateOnline, simulated) {
    const pill = document.getElementById('netStatus');
    const label = pill.querySelector('.net-label');
    const toggle = document.getElementById('netToggle');
    pill.className = 'net-pill ' + (stateOnline ? 'net-online' : 'net-offline');
    label.textContent = stateOnline ? (simulated ? 'En línea' : 'En línea') : 'Offline';
    toggle.textContent = stateOnline ? 'Simular offline' : 'Volver en línea';
  }

  async function updateOutboxBadge() {
    const n = await Sync.pendingCount();
    const badge = document.getElementById('outboxBadge');
    badge.textContent = n;
    badge.classList.toggle('has-items', n > 0);
  }

  function openSidebar() { document.getElementById('sidebar').classList.add('open'); document.getElementById('backdrop').classList.add('show'); }
  function closeSidebar() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('backdrop').classList.remove('show'); }

  /* ---------- Boot ---------- */
  async function boot() {
    await Seed.ensure(false);
    await Net.init();

    // Top bar events.
    document.getElementById('menuToggle').onclick = openSidebar;
    document.getElementById('backdrop').onclick = closeSidebar;
    document.getElementById('netToggle').onclick = () => Net.setSim(Net.isOnline());

    // Bus subscriptions.
    Bus.on('net:change', ({ online, simulated }) => { updateNetUI(online, simulated); });
    Bus.on('outbox:change', updateOutboxBadge);
    Bus.on('data:change', () => { /* views refresh on navigation; badge already handled */ updateOutboxBadge(); });
    Bus.on('alert', ({ paciente, sintomas }) => {
      UI.modal(`
        <h2 style="color:var(--red)">🔴 Bandera roja</h2>
        <p>El paciente <strong>${paciente}</strong> reportó: <strong>${sintomas}</strong>.</p>
        <p>Se ha escalado al equipo clínico de inmediato (§5.3). Verifique la cola de revisión y contacte al paciente.</p>
        <div class="modal-foot"><button class="btn danger" id="alertOk">Entendido, atender</button></div>`,
        { onMount(root) { root.querySelector('#alertOk').onclick = UI.closeModal; } });
    });

    updateNetUI(Net.isOnline(), Net.isSimulated());
    await updateOutboxBadge();

    window.addEventListener('hashchange', navigate);
    await navigate();

    // Register service worker for offline app shell.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW no registrado:', e));
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
