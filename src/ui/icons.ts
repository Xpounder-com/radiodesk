const paths: Record<string,string> = {
 station:'<path d="M12 7v14M8 21h8M9 13l-4 8M15 13l4 8M9 3a5 5 0 0 0 0 8M15 3a5 5 0 0 1 0 8M6 1a9 9 0 0 0 0 12M18 1a9 9 0 0 1 0 12"/><circle cx="12" cy="7" r="1.5"/>',
 signal:'<path d="M2 12h4l2-8 4 16 3-12 2 4h5"/>',
 sdr:'<path d="M3 19V5M3 19h18M6 16l3-2 2-9 3 12 3-5 4 4"/>',
 digital:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M6 9h3v6h3V9h3v6h3M7 4V2M17 4V2M7 22v-2M17 22v-2"/>',
 engineering:'<path d="m14 6 4-4a6 6 0 0 1-8 8L3 17a3 3 0 0 0 4 4l7-7a6 6 0 0 1 8-8l-4 4z"/>',
 logbook:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h4"/>',
 propagation:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
 devices:'<path d="M12 3v17M12 7l-5 3v5M12 11l5 3v-6"/><circle cx="7" cy="17" r="2"/><rect x="15" y="4" width="4" height="4"/><path d="m9 5 3-3 3 3"/>',
 settings:'<path d="m9 3-1 3-3 1v4l-2 1 2 1v4l3 1 1 3h6l1-3 3-1v-4l2-1-2-1V7l-3-1-1-3z"/><circle cx="12" cy="12" r="3"/>',
 folder:'<path d="M3 6h6l2 2h10v12H3z"/>',
 link:'<path d="m10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 0) scale(.9)"/>',
 plus:'<path d="M12 5v14M5 12h14"/>', minus:'<path d="M5 12h14"/>',
 play:'<path d="m8 4 12 8-12 8z"/>',pause:'<path d="M8 5v14M16 5v14"/>',
 download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',upload:'<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
 search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>', close:'<path d="m6 6 12 12M6 18 18 6"/>',
 check:'<path d="m5 12 4 4L19 6"/>', info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
 mic:'<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
 trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
 keyboard:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h1m3 0h1m3 0h1m3 0h1M6 13h1m3 0h1m3 0h1m3 0h1M7 16h10"/>'
};
export function icon(name:string,cls=''):string { return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]??paths.info}</svg>`; }
