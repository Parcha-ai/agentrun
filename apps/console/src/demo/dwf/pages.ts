// Page images for the fixtures: a certificate of incorporation drawn as SVG, as `pdf_pages` would render a scanned one.
// Each is a data: URL, so the stories need no files and no server. Every company, number and official is invented.

export type Company = { name: string; file: string; state: string; number: string; filed: string; officer: string };

export const COMPANIES: Company[] = [
  ["Bramblewood Freight LLC", "Delaware", "6012477", "2019-03-14", "Ines Calloway"],
  ["Corvane Analytics Inc.", "Delaware", "7340291", "2021-08-02", "Ines Calloway"],
  ["Duskridge Holdings Ltd.", "Nevada", "E0583322017-4", "2017-11-20", "Marcus Teague"],
  ["Ellery & Thorn Supply Co.", "Wyoming", "2020-000918273", "2020-01-09", "Dana Whitlock"],
  ["Fenwhistle Robotics Inc.", "Delaware", "5523108", "2015-06-30", "Ines Calloway"],
  ["Glasswing Ceramics LLC", "Oregon", "1588420-97", "2018-04-11", "Paul Okafor"],
  ["Harrowgate Logistics Corp.", "Texas", "0803119462", "2016-09-27", "Rosa Lindqvist"],
  ["Ivorybrook Dental Group PLLC", "New York", "5932174", "2021-02-18", "Thomas Achebe"],
  ["Juniper Kettle Foods Inc.", "California", "C4419027", "2019-12-05", "Mei Harrington"],
  ["Kestrelmoor Energy LLC", "Colorado", "20201774650", "2020-07-21", "Gil Ferreira"],
  ["Lanternfield Studios Inc.", "Delaware", "6630085", "2022-05-03", "Ines Calloway"],
  ["Marrowby Textiles Ltd.", "North Carolina", "1830442", "2014-10-14", "Ada Nwosu"],
  ["Northpine Brewing Co.", "Washington", "604 118 772", "2013-03-29", "Lena Sorensen"],
  ["Oakhollow Medical Supply LLC", "Florida", "L19000227781", "2019-08-16", "Victor Mendes"],
  ["Pellucid Water Systems Inc.", "Arizona", "23300912", "2023-01-23", "Helen Marsh"],
  ["Quillon Security Group LLC", "Virginia", "S8820145", "2018-11-02", "Jonah Pryce"],
  ["Rookery Lane Bakeries Inc.", "Massachusetts", "001492275", "2012-04-17", "Clara Beaumont"],
  ["Saltmarsh Outdoor Gear Co.", "Maine", "20170833DC", "2017-06-08", "Owen Tate"],
  ["Tidewell Marine Services LLC", "Louisiana", "42188115K", "2016-02-25", "Yvette Robichaux"],
  ["Umberfold Paper Works Inc.", "Wisconsin", "U071244", "2011-09-12", "Karl Ostrowski"],
].map(([name, state, number, filed, officer]) => ({ name, state, number, filed, officer, file: `coi-${name.split(/[^A-Za-z]/)[0].toLowerCase()}.pdf` }));

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** A certificate's first page. `altered` pastes the filing date in another face, off the baseline; `noSeal` leaves the seal off. */
export function certificate(c: Company, { altered = false, noSeal = false, faint = false } = {}): string {
  const ink = faint ? "#9a958a" : "#2b2a27";
  const lines = [
    `I, ${c.officer}, Secretary of State of the State of ${c.state},`,
    "do hereby certify that the attached is a true and correct copy",
    `of the Certificate of Incorporation of "${c.name.toUpperCase()}",`,
    `filed in this office on the date below, under file number ${c.number}.`,
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="850" height="1100" viewBox="0 0 850 1100">
<rect width="850" height="1100" fill="#fbf9f3"/>
<rect x="38" y="38" width="774" height="1024" fill="none" stroke="#7a6a48" stroke-width="3"/>
<rect x="50" y="50" width="750" height="1000" fill="none" stroke="#7a6a48" stroke-width="1"/>
<text x="425" y="150" font-family="Georgia, serif" font-size="30" text-anchor="middle" fill="${ink}" letter-spacing="3">STATE OF ${esc(c.state.toUpperCase())}</text>
<text x="425" y="195" font-family="Georgia, serif" font-size="20" text-anchor="middle" fill="${ink}">OFFICE OF THE SECRETARY OF STATE</text>
<line x1="200" y1="225" x2="650" y2="225" stroke="#7a6a48"/>
<text x="425" y="300" font-family="Georgia, serif" font-size="36" font-style="italic" text-anchor="middle" fill="${ink}">Certificate of Incorporation</text>
<text x="425" y="380" font-family="Georgia, serif" font-size="28" font-weight="bold" text-anchor="middle" fill="${ink}">${esc(c.name)}</text>
${lines.map((l, i) => `<text x="110" y="${470 + i * 38}" font-family="Georgia, serif" font-size="19" fill="${ink}">${esc(l)}</text>`).join("\n")}
<text x="110" y="660" font-family="Georgia, serif" font-size="19" fill="${ink}">Filed:</text>
${altered
    ? `<rect x="176" y="640" width="260" height="30" fill="#fdfdfd"/><text x="182" y="663" font-family="Arial, sans-serif" font-size="18" fill="#1d1d1d">${esc(longDate(c.filed))}</text>`
    : `<text x="180" y="660" font-family="Georgia, serif" font-size="19" fill="${ink}">${esc(longDate(c.filed))}</text>`}
<text x="110" y="700" font-family="Georgia, serif" font-size="19" fill="${ink}">File number: ${esc(c.number)}</text>
${noSeal ? "" : `<g transform="translate(220 860)"><circle r="92" fill="none" stroke="#a3342c" stroke-width="4"/><circle r="74" fill="none" stroke="#a3342c" stroke-width="1.5"/><text y="-30" font-family="Georgia, serif" font-size="15" text-anchor="middle" fill="#a3342c">GREAT SEAL</text><text y="6" font-family="Georgia, serif" font-size="22" text-anchor="middle" fill="#a3342c" font-weight="bold">${esc(c.state.toUpperCase().slice(0, 12))}</text><text y="38" font-family="Georgia, serif" font-size="14" text-anchor="middle" fill="#a3342c">FILED</text></g>`}
<path d="M 520 880 C 545 840, 560 905, 585 860 S 625 850, 640 880 S 690 860, 720 872" fill="none" stroke="#1f2b5c" stroke-width="2.4"/>
<line x1="500" y1="905" x2="740" y2="905" stroke="${ink}"/>
<text x="620" y="930" font-family="Georgia, serif" font-size="16" text-anchor="middle" fill="${ink}">${esc(c.officer)}, Secretary of State</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
