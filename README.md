# Seguimiento de Pacientes vía WhatsApp · Clínica de Oncogeriatría

Prototipo funcional (PWA estática) que implementa, en el navegador, el plan de
seguimiento de pacientes oncogeriátricos por WhatsApp. Pensado para validar el
flujo clínico, la arquitectura offline-first y el módulo de agenda sin necesidad
de backend.

> ⚠️ **Demostración.** Funciona 100% en el navegador con datos sintéticos. No hay
> servidor, no se envían mensajes reales de WhatsApp y ningún dato sale del
> dispositivo. GitHub Pages sirve solo archivos estáticos, por lo que el servidor,
> el BSP y la API de Meta están **simulados**.

## Qué implementa

| Sección del plan | En el prototipo |
|---|---|
| §4 Cumplimiento legal | Captura de consentimiento diferenciado, opt-out / revocación, minimización de datos |
| §5 Flujo de seguimiento | Simulador de WhatsApp con botones, una pregunta a la vez, tono de usted, triage 🟢🟡🔴 y escalamiento inmediato de banderas rojas |
| §6 Offline-first | IndexedDB, cola de salida (outbox), motor de sincronización con reintentos, idempotencia por `client_id`, cola de conflictos, doble sello de tiempo |
| §7 Agenda | Disponibilidad calculada contra la agenda real, filtro por especialidad/sede, reserva con lock optimista, importación/exportación CSV con vista previa |
| §9 Métricas | KPIs calculados en vivo sobre los datos cargados |

## Cómo probarlo

1. **Seguimiento:** complete una valoración. Marque un síntoma de alarma para ver
   el escalamiento rojo inmediato.
2. **Offline:** pulse "Simular offline" (barra superior), registre valoraciones o
   reserve cupos: quedan *pendientes* en la cola.
3. **Reconexión:** vuelva en línea y observe la cola de **Sincronización**
   confirmando cada operación.
4. **Conflictos:** en **Agenda**, reserve un cupo offline y use "Simular reserva
   concurrente" para generar un conflicto que va a revisión manual.
5. **CSV:** exporte la agenda, edítela en Excel/Sheets y reimpórtela con vista previa.

## Tecnología

HTML + CSS + JavaScript vanilla, sin dependencias ni paso de compilación.
IndexedDB para persistencia local y un Service Worker para que la app funcione sin
conexión (instalable como PWA).

## Estructura

```
index.html              Shell de la aplicación
manifest.webmanifest    Metadatos PWA
sw.js                   Service Worker (cache del app shell)
css/styles.css          Estilos
js/db.js                Capa IndexedDB
js/seed.js              Datos sintéticos de demostración
js/csv.js               Parser/serializador CSV
js/sync.js              Bus + Net + motor de sincronización offline-first
js/agenda.js            Módulo de agenda (§7)
js/followup.js          Flujo de seguimiento WhatsApp (§5)
js/patients.js          Pacientes y consentimiento (§4)
js/dashboard.js         Tablero, sincronización, métricas, acerca
js/app.js               Router + helpers de UI
```

## Desarrollo local

Sirva la carpeta con cualquier servidor estático (el Service Worker requiere
`http://`, no `file://`):

```bash
npx serve .
# o
python -m http.server 8080
```
