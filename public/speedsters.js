/**
 * The "in progress" flare's icons: things that are fast, each drawn for this
 * app (none is an existing character or brand). A different one shows for
 * each action. All share a 64×32 box, speed streaks on the left (sp-streak),
 * and a body that bobs (sp-body); parts animate with sp-spin (wheels, rotors),
 * sp-flame (exhaust), sp-flap (wings, fins), sp-run (legs), sp-blink (lights).
 * styles.css animates them, slows them to a stop when the action is done, and
 * respects reduced motion.
 */

const streaks = (a = '#b45309', b = '#d97706') => `<g class="sp-streaks" stroke-linecap="round">
  <line class="sp-streak" x1="2" y1="11" x2="16" y2="11" stroke="${a}" stroke-width="1.6" />
  <line class="sp-streak b" x1="0" y1="17" x2="18" y2="17" stroke="${b}" stroke-width="2" />
  <line class="sp-streak c" x1="4" y1="23" x2="15" y2="23" stroke="${a}" stroke-width="1.4" /></g>`;

const svg = (body, streakColours) => `<svg viewBox="0 0 64 32" aria-hidden="true">${streaks(...(streakColours ?? []))}<g class="sp-body">${body}</g></svg>`;

const wheel = (cx, cy, r, tyre = '#111827') =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${tyre}" /><g class="sp-spin"><circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="#9ca3af" /><path d="M${cx - r * 0.55} ${cy} H${cx + r * 0.55} M${cx} ${cy - r * 0.55} V${cy + r * 0.55}" stroke="#374151" stroke-width="0.9" /></g>`;

export const SPEEDSTERS = [
  {
    name: 'caped speedster',
    svg: svg(`<path class="sp-flap" d="M44 13 C36 6 27 5 18 8 C24 11 27 15 22 21 C30 19 37 18 42 17 Z" fill="#ea580c" />
      <path d="M24 16 L15 15.2 M24 19 L16 20.5" stroke="#4c1d95" stroke-width="3.2" stroke-linecap="round" />
      <path d="M15.6 15.1 l-2.4 -0.2 M16.6 20.4 l-2.4 0.5" stroke="#111827" stroke-width="3.4" stroke-linecap="round" />
      <rect x="23" y="12.6" width="21" height="8" rx="4" fill="#6d28d9" /><rect x="23" y="16.4" width="21" height="1.6" fill="#fff" />
      <path d="M43 14 L56 11.5" stroke="#6d28d9" stroke-width="3.2" stroke-linecap="round" /><circle cx="57.4" cy="11.2" r="2" fill="#f1c27d" />
      <circle cx="48.4" cy="13.4" r="4.6" fill="#f1c27d" /><path d="M44.2 12.6 C44.8 8.4 50.6 7.6 52.6 10.6 C50.4 10 47.4 10.6 46 13.2 Z" fill="#1f2937" />
      <path d="M47.6 13.2 h4" stroke="#1f2937" stroke-width="1.6" stroke-linecap="round" />`),
  },
  {
    name: 'rocket',
    svg: svg(`<path class="sp-flame" d="M24 12.5 L11 16 L24 19.5 Z" fill="#f97316" /><path class="sp-flame b" d="M24 14 L16 16 L24 18 Z" fill="#fde047" />
      <path d="M28 11.5 L22 5 L33 10.5 Z M28 20.5 L22 27 L33 21.5 Z" fill="#dc2626" />
      <path d="M23 16 C29 8.5 46 8.5 58 16 C46 23.5 29 23.5 23 16 Z" fill="#e5e7eb" stroke="#6b7280" stroke-width="1" />
      <circle cx="44" cy="16" r="3.2" fill="#38bdf8" stroke="#1e3a8a" stroke-width="1" /><path d="M52 12.6 C55 14 56.5 15 58 16 C56.5 17 55 18 52 19.4 Z" fill="#dc2626" />`),
  },
  {
    name: 'race car',
    svg: svg(`<path d="M18 21 L22 14.5 L35 12.5 L46 14 L59 17.5 L59 21 Z" fill="#dc2626" /><rect x="17" y="10.5" width="4" height="5" rx="1" fill="#991b1b" />
      <path d="M33 13 L41 13 L43.5 15.5 L32 15.5 Z" fill="#1f2937" /><path d="M24 18 H56" stroke="#fde047" stroke-width="1.2" />
      ${wheel(25, 22, 3.6)}${wheel(52, 22, 3.6)}`),
  },
  {
    name: 'cheetah',
    svg: svg(`<path class="sp-run" d="M48 19 L58 24" stroke="#d97706" stroke-width="2.6" stroke-linecap="round" /><path class="sp-run b" d="M30 19 L19 24" stroke="#d97706" stroke-width="2.6" stroke-linecap="round" />
      <path d="M27 16 C21 12 18 14 15 9" fill="none" stroke="#f59e0b" stroke-width="2.2" stroke-linecap="round" />
      <ellipse cx="38" cy="16.5" rx="12" ry="5" fill="#f59e0b" /><circle cx="52" cy="13.5" r="4.4" fill="#f59e0b" /><path d="M50 9.6 l1.2 -2.6 l1.6 2.4 Z" fill="#b45309" />
      <circle cx="33" cy="15" r="1" fill="#78350f" /><circle cx="38" cy="18" r="1" fill="#78350f" /><circle cx="42" cy="14.5" r="1" fill="#78350f" /><circle cx="29" cy="18" r="0.9" fill="#78350f" />
      <circle cx="53.6" cy="12.6" r="0.9" fill="#111827" /><path d="M56 14.8 h-2" stroke="#78350f" stroke-width="0.8" />`),
  },
  {
    name: 'jet',
    svg: svg(`<path class="sp-flame" d="M18 14.6 L10 16 L18 17.4 Z" fill="#f97316" />
      <path d="M33 15 L24 5 L29.5 5 L42 15 Z M33 17 L24 27 L29.5 27 L42 17 Z" fill="#64748b" /><path d="M20 15.5 L16 9 L21.5 9 L26 15 Z" fill="#475569" />
      <path d="M18 14.5 L52 14 Q61 16 52 18 L18 17.5 Z" fill="#cbd5e1" stroke="#64748b" stroke-width="0.8" /><path d="M48 14.6 Q53 15 55 16 L48 16 Z" fill="#38bdf8" />`),
  },
  {
    name: 'lightning bolt',
    svg: svg(`<path class="sp-blink" d="M42 2 L28 18 H38 L32 30 L52 12 H41 L48 2 Z" fill="#facc15" stroke="#a16207" stroke-width="1.2" stroke-linejoin="round" />
      <path d="M54 6 l3 -2 M56 12 l4 0 M24 24 l-3 2" stroke="#ca8a04" stroke-width="1.2" stroke-linecap="round" />`),
  },
  {
    name: 'comet',
    svg: svg(`<path d="M50 9.5 L14 13.5 L14 18.5 L50 22.5 Z" fill="#fde68a" opacity="0.8" /><path class="sp-flame" d="M50 12 L24 15 L24 17 L50 20 Z" fill="#f97316" opacity="0.75" />
      <circle cx="50" cy="16" r="6.4" fill="#fbbf24" stroke="#d97706" stroke-width="1" /><circle cx="48" cy="14" r="1.6" fill="#fef3c7" />`),
  },
  {
    name: 'bullet train',
    svg: svg(`<path d="M16 22 L16 13 Q16 10.5 19 10.5 L44 10.5 Q57 11.5 61 22 Z" fill="#f8fafc" stroke="#475569" stroke-width="1" />
      <rect x="20" y="13" width="26" height="3.4" rx="1.4" fill="#1e3a8a" /><path d="M16 19 H58" stroke="#2563eb" stroke-width="1.6" />
      <path d="M46 13 Q52 13.6 55 17 L46 17 Z" fill="#1e3a8a" /><path d="M14 23.5 H62" stroke="#6b7280" stroke-width="1" />`),
  },
  {
    name: 'motorbike',
    svg: svg(`${wheel(22, 23, 4.6)}${wheel(48, 23, 4.6)}
      <path d="M22 23 L31 15 L44 15 L48 23 M31 15 L37 22 L44 15" fill="none" stroke="#dc2626" stroke-width="2" stroke-linejoin="round" />
      <path d="M33 14 C35 9 40 8 42 11 L44 15" fill="none" stroke="#1f2937" stroke-width="3" stroke-linecap="round" />
      <circle cx="43" cy="7.5" r="3.4" fill="#dc2626" /><path d="M44 7 h2.8" stroke="#bae6fd" stroke-width="1.4" /><path d="M44 15 L49 12" stroke="#374151" stroke-width="1.6" />`),
  },
  {
    name: 'speedboat',
    svg: svg(`<path d="M17 18 L58 17 L52 24.5 L22 24.5 Z" fill="#ef4444" /><path d="M20 21 H54" stroke="#fff" stroke-width="1" />
      <path d="M33 17.6 L38 12 L47 12 L49.5 17.3 Z" fill="#e0f2fe" stroke="#0369a1" stroke-width="0.8" />
      <path class="sp-flap" d="M14 25 Q18 22 22 25 Q26 28 30 25" fill="none" stroke="#38bdf8" stroke-width="1.6" stroke-linecap="round" />`, ['#0284c7', '#38bdf8']),
  },
  {
    name: 'falcon',
    svg: svg(`<path class="sp-flap" d="M44 15 L30 4 L33 4 L48 14.6 Z" fill="#92400e" /><path class="sp-flap b" d="M44 17 L30 28 L33 28 L48 17.4 Z" fill="#78350f" />
      <path d="M22 16 L28 13.5 L50 14 Q58 15 60 16.6 Q56 18 50 18 L28 18.5 Z" fill="#b45309" /><path d="M22 16 L16 13 M22 16 L16 19" stroke="#92400e" stroke-width="1.8" stroke-linecap="round" />
      <circle cx="54" cy="15.2" r="1" fill="#111827" /><path d="M59.6 16.4 L62 17.2 L59.4 17.6 Z" fill="#facc15" />`),
  },
  {
    name: 'paper plane',
    svg: svg(`<path d="M16 19 L60 8 L36 25 Z" fill="#e0e7ff" stroke="#4f46e5" stroke-width="1.1" stroke-linejoin="round" /><path d="M60 8 L31 20 L36 25" fill="#c7d2fe" stroke="#4f46e5" stroke-width="1.1" stroke-linejoin="round" />`, ['#6366f1', '#818cf8']),
  },
  {
    name: 'sprinter',
    svg: svg(`<circle cx="49" cy="7.5" r="3.2" fill="#f1c27d" /><path d="M47 10.5 L38 18" stroke="#2563eb" stroke-width="3.6" stroke-linecap="round" />
      <path class="sp-run" d="M45 12.5 L53 16" stroke="#f1c27d" stroke-width="1.8" stroke-linecap="round" /><path class="sp-run b" d="M44 12 L36 9" stroke="#f1c27d" stroke-width="1.8" stroke-linecap="round" />
      <path class="sp-run" d="M38 18 L44 22 L42 28" fill="none" stroke="#111827" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
      <path class="sp-run b" d="M38 18 L30 22 L24 20" fill="none" stroke="#111827" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />`),
  },
  {
    name: 'roller skate',
    svg: svg(`<path d="M24 20 L24 8 L36 8 L37 14 Q50 15 54 20 Z" fill="#ec4899" stroke="#9d174d" stroke-width="1" /><path d="M25 11 H35 M25 14 H35" stroke="#fff" stroke-width="1" />
      <rect x="22" y="20" width="34" height="2.4" rx="1" fill="#6b7280" />${wheel(27, 25.5, 2.8, '#7c3aed')}${wheel(35, 25.5, 2.8, '#7c3aed')}${wheel(43, 25.5, 2.8, '#7c3aed')}${wheel(51, 25.5, 2.8, '#7c3aed')}`),
  },
  {
    name: 'shooting star',
    svg: svg(`<path d="M44 12 L14 6 M44 16 L12 16 M44 20 L14 26" stroke="#fbbf24" stroke-width="1.6" stroke-linecap="round" opacity="0.7" />
      <path class="sp-blink" d="M50 5 L53 12.5 L61 13 L55 18 L57 26 L50 21.6 L43 26 L45 18 L39 13 L47 12.5 Z" fill="#facc15" stroke="#ca8a04" stroke-width="1" stroke-linejoin="round" />`),
  },
  {
    name: 'saucer',
    svg: svg(`<path d="M34 14 Q42 4 50 14 Z" fill="#bae6fd" stroke="#0369a1" stroke-width="1" /><ellipse cx="42" cy="17" rx="18" ry="5" fill="#64748b" stroke="#334155" stroke-width="1" />
      <circle class="sp-blink" cx="32" cy="17.5" r="1.3" fill="#fde047" /><circle class="sp-blink b" cx="42" cy="19" r="1.3" fill="#86efac" /><circle class="sp-blink" cx="52" cy="17.5" r="1.3" fill="#f9a8d4" />`, ['#475569', '#94a3b8']),
  },
  {
    name: 'hare',
    svg: svg(`<path class="sp-run" d="M48 19 L58 23" stroke="#a8a29e" stroke-width="2.4" stroke-linecap="round" /><path class="sp-run b" d="M30 19 L20 24" stroke="#a8a29e" stroke-width="2.6" stroke-linecap="round" />
      <ellipse cx="38" cy="16.5" rx="11" ry="5" fill="#d6d3d1" /><circle cx="27" cy="15" r="2.4" fill="#fff" />
      <circle cx="51" cy="13" r="4" fill="#d6d3d1" /><path d="M49 10 L44 2.5 L47.5 2.4 L51.5 9.4 Z M51 9.6 L49 2 L52.4 2.2 L53 9.4 Z" fill="#d6d3d1" stroke="#a8a29e" stroke-width="0.6" />
      <circle cx="52.6" cy="12.4" r="0.9" fill="#111827" /><circle cx="55" cy="14" r="0.8" fill="#f472b6" />`),
  },
  {
    name: 'arrow',
    svg: svg(`<path d="M18 16 H55" stroke="#78350f" stroke-width="2" stroke-linecap="round" /><path d="M54 11.5 L62 16 L54 20.5 Z" fill="#6b7280" stroke="#374151" stroke-width="0.8" />
      <path class="sp-flap" d="M18 16 L24 9.5 L29 9.5 L24 16 Z M18 16 L24 22.5 L29 22.5 L24 16 Z" fill="#dc2626" />`),
  },
  {
    name: 'dolphin',
    svg: svg(`<path d="M18 20 C26 10 42 8 56 12 C52 14 50 15 49 16 C42 18 32 20 24 22 Z" fill="#38bdf8" stroke="#0369a1" stroke-width="0.9" />
      <path d="M38 11 L40 5 L44 10.6 Z" fill="#0284c7" /><path class="sp-flap" d="M20 20 L13 15.5 L15 21 L13 26 Z" fill="#0284c7" />
      <circle cx="51" cy="12.6" r="0.9" fill="#111827" /><path d="M30 25 Q34 23 38 25 Q42 27 46 25" fill="none" stroke="#7dd3fc" stroke-width="1.4" stroke-linecap="round" />`, ['#0284c7', '#38bdf8']),
  },
  {
    name: 'drone',
    svg: svg(`<rect x="30" y="12" width="20" height="6" rx="2.4" fill="#334155" /><path d="M32 12 V8.5 M48 12 V8.5" stroke="#334155" stroke-width="1.6" />
      <ellipse class="sp-spin-x" cx="32" cy="8" rx="7" ry="1.2" fill="#94a3b8" /><ellipse class="sp-spin-x b" cx="48" cy="8" rx="7" ry="1.2" fill="#94a3b8" />
      <circle class="sp-blink" cx="47.5" cy="15" r="1" fill="#ef4444" /><path d="M40 18 V21" stroke="#475569" stroke-width="1" /><rect x="35.5" y="21" width="9" height="6.5" rx="1" fill="#d97706" stroke="#92400e" stroke-width="0.8" />`),
  },
  {
    name: 'cyclist',
    svg: svg(`${wheel(22, 23, 5)}${wheel(48, 23, 5)}
      <path d="M22 23 L30 15 L44 15 L48 23 M30 15 L35 23 L44 15" fill="none" stroke="#16a34a" stroke-width="1.8" stroke-linejoin="round" />
      <path d="M33 13 L42 9.5" stroke="#f59e0b" stroke-width="3.4" stroke-linecap="round" /><circle cx="45" cy="8" r="2.8" fill="#f1c27d" /><path d="M42.4 6.6 Q45 3.6 48 6" fill="#16a34a" stroke="#16a34a" stroke-width="1.6" />
      <path class="sp-run" d="M33.5 13.5 L36 19 L34 23" fill="none" stroke="#1f2937" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /><path d="M42 10 L45 15" stroke="#f1c27d" stroke-width="1.4" stroke-linecap="round" />`),
  },
];

let last = -1;
let order = [];
/** A different one each time: every icon once, in a shuffled order, then shuffle again (never the same twice in a row). */
export function nextSpeedster() {
  if (!order.length) {
    order = SPEEDSTERS.map((_, i) => i).sort(() => Math.random() - 0.5);
    if (order[0] === last && order.length > 1) order.push(order.shift());
  }
  last = order.shift();
  return SPEEDSTERS[last];
}
