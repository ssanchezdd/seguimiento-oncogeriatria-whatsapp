/* seed.js — synthetic demo data so the prototype is usable immediately.
 * All data is fictional. Nothing leaves the browser.
 */
(function () {
  const PRACTITIONERS = [
    { id: 'P001', nombre: 'Dra. Ana Ruiz',    especialidades: ['Oncología'],     sede: 'Sede Norte',  activo: true },
    { id: 'P002', nombre: 'Dr. Luis Páez',     especialidades: ['Geriatría'],     sede: 'Sede Norte',  activo: true },
    { id: 'P003', nombre: 'Dra. Marta Gómez',  especialidades: ['Oncogeriatría'], sede: 'Sede Centro', activo: true },
    { id: 'P004', nombre: 'Enf. Clara Díaz',   especialidades: ['Enfermería'],    sede: 'Sede Norte',  activo: true },
    { id: 'P005', nombre: 'Dr. Jorge Niño',    especialidades: ['Oncología'],     sede: 'Sede Centro', activo: false }
  ];

  const TEMPLATES = [
    { profesional_id: 'P001', dia_semana: 'lunes',     hora_inicio: '08:00', hora_fin: '12:00', duracion_min: 30, sede: 'Sede Norte' },
    { profesional_id: 'P001', dia_semana: 'miercoles', hora_inicio: '14:00', hora_fin: '18:00', duracion_min: 30, sede: 'Sede Norte' },
    { profesional_id: 'P002', dia_semana: 'martes',    hora_inicio: '09:00', hora_fin: '13:00', duracion_min: 20, sede: 'Sede Norte' },
    { profesional_id: 'P002', dia_semana: 'jueves',    hora_inicio: '09:00', hora_fin: '12:00', duracion_min: 20, sede: 'Sede Norte' },
    { profesional_id: 'P003', dia_semana: 'lunes',     hora_inicio: '09:00', hora_fin: '12:00', duracion_min: 30, sede: 'Sede Centro' },
    { profesional_id: 'P003', dia_semana: 'viernes',   hora_inicio: '08:00', hora_fin: '11:00', duracion_min: 30, sede: 'Sede Centro' },
    { profesional_id: 'P004', dia_semana: 'lunes',     hora_inicio: '08:00', hora_fin: '10:00', duracion_min: 15, sede: 'Sede Norte' },
    { profesional_id: 'P004', dia_semana: 'martes',    hora_inicio: '08:00', hora_fin: '10:00', duracion_min: 15, sede: 'Sede Norte' },
    { profesional_id: 'P004', dia_semana: 'miercoles', hora_inicio: '08:00', hora_fin: '10:00', duracion_min: 15, sede: 'Sede Norte' },
    { profesional_id: 'P004', dia_semana: 'jueves',    hora_inicio: '08:00', hora_fin: '10:00', duracion_min: 15, sede: 'Sede Norte' },
    { profesional_id: 'P004', dia_semana: 'viernes',   hora_inicio: '08:00', hora_fin: '10:00', duracion_min: 15, sede: 'Sede Norte' }
  ].map((t) => Object.assign({ id: DB.uuid() }, t));

  function isoDate(d) { return d.toISOString().slice(0, 10); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

  function buildPatients() {
    const today = new Date();
    const base = [
      ['Rosa Helena Méndez',  '+57 310 555 0101', 'Hijo: Carlos Méndez +57 311 555 0190', true,  false],
      ['José Antonio Pardo',  '+57 312 555 0102', 'Esposa: Lucía Pardo +57 313 555 0191',  true,  false],
      ['Carmen Lucía Soto',   '+57 314 555 0103', '',                                       true,  false],
      ['Gilberto Ramírez',    '+57 315 555 0104', 'Hija: Ana Ramírez +57 316 555 0192',     true,  false],
      ['María Inés Quiroga',  '+57 317 555 0105', 'Sobrino: Pedro Q. +57 318 555 0193',     true,  false],
      ['Hernando Vélez',      '+57 319 555 0106', 'Hija: Sofía Vélez +57 320 555 0194',     false, false],
      ['Blanca Estela Niño',  '+57 321 555 0107', 'Cuidadora: Rosa T. +57 322 555 0195',    true,  true],
      ['Álvaro Cárdenas',     '+57 323 555 0108', '',                                       true,  false],
      ['Teresa de Jesús León','+57 324 555 0109', 'Hijo: Mario León +57 325 555 0196',      true,  false],
      ['Efraín Mosquera',     '+57 326 555 0110', 'Hija: Diana M. +57 327 555 0197',        true,  false]
    ];
    return base.map((p, i) => ({
      client_id: DB.uuid(),
      id: 'PT' + String(i + 1).padStart(3, '0'),
      nombre: p[0],
      telefono_paciente: p[1],
      cuidador: p[2],
      consentimiento: p[3],
      consent_fecha: p[3] ? isoDate(addDays(today, -(i + 3))) : null,
      opt_out: p[4],
      estado: 'confirmado',
      ultimo_seguimiento: i < 4 ? isoDate(addDays(today, -(i + 1))) : null
    }));
  }

  function buildAssessments(patients) {
    const today = new Date();
    // A handful of historical assessments to populate the metrics.
    const rows = [
      { pi: 0, dias: -2, estado_general: 'bien',    alarma: false, adherencia: 'si',     clas: 'verde',    intervencion: false },
      { pi: 1, dias: -2, estado_general: 'regular', alarma: false, adherencia: 'a_veces', clas: 'amarillo', intervencion: true },
      { pi: 2, dias: -3, estado_general: 'bien',    alarma: false, adherencia: 'si',     clas: 'verde',    intervencion: false },
      { pi: 3, dias: -4, estado_general: 'mal',     alarma: true,  adherencia: 'no',     clas: 'rojo',     intervencion: true },
      { pi: 8, dias: -1, estado_general: 'bien',    alarma: false, adherencia: 'si',     clas: 'verde',    intervencion: false }
    ];
    return rows.map((r) => ({
      client_id: DB.uuid(),
      paciente_id: patients[r.pi].id,
      paciente_nombre: patients[r.pi].nombre,
      fecha: isoDate(addDays(today, r.dias)),
      estado_general: r.estado_general,
      sintomas_alarma: r.alarma,
      adherencia: r.adherencia,
      nota: '',
      clasificacion: r.clas,
      intervencion_humana: r.intervencion,
      estado: 'confirmado',
      created_local: addDays(today, r.dias).toISOString(),
      confirmed_server: addDays(today, r.dias).toISOString()
    }));
  }

  const Seed = {
    PRACTITIONERS, TEMPLATES,

    async ensure(force) {
      const seeded = await DB.flag('seeded');
      if (seeded && !force) return false;
      await DB.clearAll();

      await DB.bulkPut('practitioners', PRACTITIONERS);
      await DB.bulkPut('templates', TEMPLATES);

      const patients = buildPatients();
      await DB.bulkPut('patients', patients);

      const assessments = buildAssessments(patients);
      await DB.bulkPut('assessments', assessments);

      // Exceptions / blocks (Plan §7.4 excepciones).
      const today = new Date();
      const exceptions = [
        { id: DB.uuid(), profesional_id: 'P001', fecha: isoDate(addDays(today, 7)),  hora_inicio: '08:00', hora_fin: '12:00', tipo: 'bloqueo', nota: 'Vacaciones' },
        { id: DB.uuid(), profesional_id: 'P002', fecha: isoDate(addDays(today, 1)),  hora_inicio: '09:00', hora_fin: '10:00', tipo: 'cerrado', nota: 'Reunión de comité' }
      ];
      await DB.bulkPut('exceptions', exceptions);

      // Generate concrete slots from templates for a two-week horizon.
      await window.Agenda.regenerateSlots({ patients });

      await DB.flag('seeded', true);
      await DB.flag('simOffline', false);
      return true;
    }
  };

  window.Seed = Seed;
})();
