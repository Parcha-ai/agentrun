# Builds the decision-demo documents: certificates of incorporation, IRS EIN confirmation letters (CP 575-style) and
# bank account letters for invented companies, rendered HTML -> PDF in a headless Chrome this script launches, and
# labels.json with the ground truth. Every company, person, bank, address, file number and EIN is invented.
#
#   python3 -I build.py OUT_DIR
import json
import math
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

AS_OF = "2026-10-30"
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
ORDINAL_DAYS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth",
                "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth",
                "twenty-first", "twenty-second", "twenty-third", "twenty-fourth", "twenty-fifth", "twenty-sixth", "twenty-seventh",
                "twenty-eighth", "twenty-ninth", "thirtieth", "thirty-first"]


def ymd(date):
    y, m, d = (int(x) for x in date.split("-"))
    return y, m, d


def us(date, sep="/", short_year=False):
    y, m, d = ymd(date)
    return f"{m:02d}{sep}{d:02d}{sep}{str(y)[2:] if short_year else y}"


def long_date(date):
    y, m, d = ymd(date)
    return f"{MONTHS[m - 1]} {d}, {y}"


def words_date(date):
    y, m, d = ymd(date)
    return f"the {ORDINAL_DAYS[d]} day of {MONTHS[m - 1]}, A.D. {y}"


# ---------------------------------------------------------------- shared pieces

BASE_CSS = """
@page { size: Letter; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { color: #151515; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { width: 8.5in; height: 11in; position: relative; overflow: hidden; page-break-after: always; background: #fff; }
.page:last-child { page-break-after: auto; }
.sig { font-family: 'Z003'; font-size: 27px; line-height: 1; color: #1b2a5c; }
.sigline { border-top: 1px solid #222; margin-top: 2px; padding-top: 3px; font-size: 10.5px; }
.whiteout { position: absolute; background: #fbfaf1; border: 1px solid #e3dfcc; box-shadow: 0 0 2px rgba(120,110,80,.35);
            font-family: 'Courier 10 Pitch', 'Liberation Mono', monospace; color: #2a2a2a; transform: rotate(-0.8deg); padding: 0 3px; }
.pasted { display: inline-block; background: #efe9d4; border: 1px solid #a99f82; box-shadow: 3px 4px 6px rgba(0,0,0,.32);
          transform: rotate(-2.2deg) translate(6px, 4px); padding: 4px 12px; font-size: 14px; font-family: 'Nimbus Sans Narrow', 'Liberation Sans Narrow'; }
"""


def seal_svg(outer, inner, color="#9a7a22", size=150, star=True, sub=""):
    r = size / 2
    tr = r - 6 - size / 14
    stars = ""
    if star:
        pts = []
        for i in range(10):
            ang = math.pi / 2 + i * math.pi / 5
            rad = 26 if i % 2 == 0 else 11
            pts.append(f"{r + rad * math.cos(ang):.1f},{r - rad * math.sin(ang):.1f}")
        stars = f'<polygon points="{" ".join(pts)}" fill="{color}" opacity=".85"/>'
    ticks = "".join(
        f'<line x1="{r + (r - 4) * math.cos(a):.1f}" y1="{r + (r - 4) * math.sin(a):.1f}" x2="{r + (r - 9) * math.cos(a):.1f}" y2="{r + (r - 9) * math.sin(a):.1f}" stroke="{color}" stroke-width="1.4"/>'
        for a in [i * math.pi / 36 for i in range(72)])
    uid = abs(hash(outer + inner)) % 100000
    return f"""<svg width="{size}" height="{size}" viewBox="0 0 {size} {size}" xmlns="http://www.w3.org/2000/svg">
  <defs><path id="c{uid}" d="M {r},{r} m -{tr},0 a {tr},{tr} 0 1,1 {2 * tr},0 a {tr},{tr} 0 1,1 -{2 * tr},0"/>
  <radialGradient id="g{uid}"><stop offset="0" stop-color="{color}" stop-opacity=".10"/><stop offset="1" stop-color="{color}" stop-opacity=".22"/></radialGradient></defs>
  <circle cx="{r}" cy="{r}" r="{r - 1}" fill="url(#g{uid})" stroke="{color}" stroke-width="2"/>
  {ticks}
  <circle cx="{r}" cy="{r}" r="{r - 27}" fill="none" stroke="{color}" stroke-width="1.2"/>
  <circle cx="{r}" cy="{r}" r="{r - 30}" fill="none" stroke="{color}" stroke-width=".6"/>
  <text font-family="Nimbus Roman" font-size="{max(6, size / 14):.1f}" font-weight="bold" fill="{color}"><textPath href="#c{uid}" startOffset="0" textLength="{2 * math.pi * tr * 0.985:.1f}" lengthAdjust="spacing">{outer}</textPath></text>
  {stars}
  <text x="{r}" y="{r + 20}" text-anchor="middle" font-family="Nimbus Roman" font-size="6.5" font-weight="bold" fill="{color}">{inner}</text>
  <text x="{r}" y="{r - 27}" text-anchor="middle" font-family="Nimbus Roman" font-size="7.5" fill="{color}">{sub}</text>
</svg>"""


def html(body, css=""):
    return f"<!doctype html><html><head><meta charset='utf-8'><style>{BASE_CSS}{css}</style></head><body>{body}</body></html>"


# ---------------------------------------------------------------- certificates of incorporation

DE_CSS = """
.de { font-family: 'Nimbus Roman'; font-size: 13.8px; line-height: 1.5; padding: 0.55in 0.8in 0.5in 0.8in; }
.de .office { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid #1d2f5e; padding-bottom: 8px; }
.de .office .t1 { font-size: 21px; font-weight: bold; letter-spacing: 3px; color: #1d2f5e; }
.de .office .t2 { font-size: 12.5px; letter-spacing: 1.5px; color: #1d2f5e; }
.de .stamp { float: right; margin: 10px 0 0 12px; width: 2.45in; border: 1px solid #333; font-family: 'Liberation Sans Narrow'; font-size: 10.3px; line-height: 1.35; padding: 5px 7px; }
.de h1 { text-align: center; font-size: 17px; letter-spacing: 1.2px; margin: 14px 0 2px; clear: both; }
.de h2 { text-align: center; font-size: 15px; margin: 2px 0 12px; }
.de p { margin: 0 0 8px; text-align: justify; }
.de .art b { letter-spacing: .5px; }
.de .incorp { margin-top: 12px; width: 3.3in; margin-left: auto; }
.de .cert { position: absolute; left: 0.8in; right: 0.8in; bottom: 0.45in; border-top: 1.5px solid #1d2f5e; padding-top: 10px; display: flex; gap: 18px; align-items: center; font-size: 12px; }
.de .cert .txt { flex: 1; }
.de .cert .sos { width: 2.4in; text-align: center; }
.de .seal-spot { width: 150px; height: 150px; flex: none; }
.de .auth { font-family: 'Liberation Sans Narrow'; font-size: 10px; margin-top: 4px; }
"""


def de_coi(d):
    name_head = d["company"].upper()
    name_body = d.get("body_company", d["company"])
    filed = d["date"]
    stamp_date = us(filed)
    cert_date = d.get("cert_text_date", filed)
    stamp_line = f"Delivered {d['time']} {stamp_date}<br>FILED {d['time']} {stamp_date}"
    if d.get("altered_stamp_from"):
        orig = us(d["altered_stamp_from"])
        stamp_line = (f"Delivered {d['time']} <span style='position:relative'>{orig}<span class='whiteout' style='left:-4px;top:-2px;width:86px;font-size:12px'>{stamp_date}</span></span><br>"
                      f"FILED {d['time']} <span style='position:relative'>{orig}<span class='whiteout' style='left:-2px;top:-3px;width:84px;font-size:12px;transform:rotate(0.9deg) translateY(1px)'>{stamp_date}</span></span>")
    sr = d["sr"]
    articles = f"""
<p class="art"><b>FIRST:</b> The name of the corporation is {name_body.rstrip(".")}.</p>
<p class="art"><b>SECOND:</b> The address of its registered office in the State of Delaware is 418 Tatnall Street, Suite 200, in the City of Wilmington, County of New Castle, 19801. The name of its registered agent at such address is Tatnall Registered Agents LLC.</p>
<p class="art"><b>THIRD:</b> The purpose of the corporation is to engage in any lawful act or activity for which corporations may be organized under the General Corporation Law of the State of Delaware.</p>
<p class="art"><b>FOURTH:</b> The total number of shares of stock which the corporation shall have authority to issue is {d['shares']} shares of Common Stock, par value {d['par']} per share.</p>
<p class="art"><b>FIFTH:</b> The name and mailing address of the incorporator is {d['incorporator']}, {d['incorporator_addr']}.</p>
<p class="art"><b>SIXTH:</b> The board of directors is expressly authorized to make, alter or repeal the bylaws of the corporation. Election of directors need not be by written ballot unless the bylaws so provide.</p>
<p>I, THE UNDERSIGNED, being the incorporator hereinbefore named, for the purpose of forming a corporation pursuant to the General Corporation Law of the State of Delaware, do make this certificate, hereby declaring and certifying that this is my act and deed and the facts herein stated are true, and accordingly have hereunto set my hand on {long_date(d['signed'])}.</p>"""
    incorp_sig = "" if d.get("no_signature") else f"<div class='sig'>{d['incorporator']}</div>"
    incorp = f"<div class='incorp'><div style='height:30px'>{incorp_sig}</div><div class='sigline'>{d['incorporator']}, Incorporator</div></div>"
    seal = "" if d.get("no_seal") else seal_svg("SECRETARY OF STATE • STATE OF DELAWARE •", "DIV. OF CORPORATIONS", sub="FILED")
    sos_sig = "" if d.get("no_signature") else "<div class='sig' style='font-size:25px'>Marguerite L. Ashbourne</div>"
    body = f"""<div class="page de">
<div class="office">{seal_svg('STATE OF DELAWARE •', '', color='#1d2f5e', size=58, star=True)}
<div><div class="t1">STATE OF DELAWARE</div><div class="t2">SECRETARY OF STATE &middot; DIVISION OF CORPORATIONS</div></div></div>
<div class="stamp">State of Delaware<br>Secretary of State<br>Division of Corporations<br>{stamp_line}<br>SR {sr} - File Number {d['file_no']}</div>
<h1>CERTIFICATE OF INCORPORATION</h1><h2>OF<br>{name_head}</h2>
{articles}
{incorp}
<div class="cert"><div class="seal-spot">{seal}</div>
<div class="txt">I, MARGUERITE L. ASHBOURNE, SECRETARY OF STATE OF THE STATE OF DELAWARE, DO HEREBY CERTIFY THE ABOVE IS A TRUE AND CORRECT COPY OF THE CERTIFICATE OF INCORPORATION OF &ldquo;{name_head}&rdquo;, FILED IN THIS OFFICE ON {words_date(cert_date).upper()}, AT {d['time']}.
<div class="auth">File No. {d['file_no']} &nbsp;&middot;&nbsp; SR {sr} &nbsp;&middot;&nbsp; Authentication: {d['auth']} &nbsp;&middot;&nbsp; Date: {us(cert_date, '-', True)}</div></div>
<div class="sos"><div style="height:30px">{sos_sig}</div><div class="sigline">Marguerite L. Ashbourne, Secretary of State</div></div></div>
</div>"""
    return html(body, DE_CSS)


FORM_CSS = """
.nv { font-family: 'Liberation Sans'; font-size: 12.6px; line-height: 1.45; padding: 0.5in 0.65in; }
.nv .hdr { display: flex; justify-content: space-between; align-items: flex-start; }
.nv .hdr .left { display: flex; gap: 12px; align-items: center; }
.nv .office { font-family: 'C059'; }
.nv .office .a { font-size: 19px; font-weight: bold; }
.nv .office .b { font-size: 12px; }
.nv .stamp { border: 1.5px solid #222; width: 2.75in; padding: 6px 8px; font-size: 10px; line-height: 1.38; display: flex; gap: 6px; }
.nv .stamp .seal-spot { width: 84px; height: 84px; flex: none; }
.nv .ttl { text-align: center; margin: 22px 0 4px; font-family: 'C059'; font-size: 17px; font-weight: bold; letter-spacing: 1px; }
.nv .sub { text-align: center; font-size: 10.5px; margin-bottom: 10px; }
.nv table { width: 100%; border-collapse: collapse; }
.nv td { border: 1px solid #333; vertical-align: top; padding: 9px 9px; }
.nv td.n { width: 1.7in; background: #ececec; font-weight: bold; font-size: 11.5px; }
.nv .val { font-family: 'Liberation Mono'; font-size: 12.4px; }
.nv .sigbox { height: 40px; }
.nv .foot { position: absolute; left: 0.65in; right: 0.65in; bottom: 0.45in; font-size: 9px; color: #444; display: flex; justify-content: space-between; border-top: 1px solid #999; padding-top: 4px; }
"""


def form_coi(d):
    st = d["state"]
    sos = d["sos"]
    seal = "" if d.get("no_seal") else seal_svg(f"THE GREAT SEAL OF THE STATE OF {st.upper()} •", "", color="#24407a", size=84, sub="")
    sig = lambda who: "" if d.get("no_signature") else f"<div class='sig' style='font-size:24px;padding-top:13px'>{who}</div>"
    chapter = d["chapter"]
    directors = "<br>".join(f"<span class='val'>{n}</span> &mdash; {a}" for n, a in d["directors"])
    body = f"""<div class="page nv">
<div class="hdr"><div class="left">{seal_svg(f'STATE OF {st.upper()} •', '', color='#24407a', size=64)}
<div class="office"><div class="a">{sos.upper()}</div><div class="b">Secretary of State<br>State of {st}<br>{d['office_addr']}</div></div></div>
<div class="stamp"><div class="seal-spot">{seal}</div><div>Filed in the office of<br><b>{sos}</b><br>Secretary of State, State of {st}<br>
Business Number<br><b>{d['business_no']}</b><br>Filing Number<br><b>{d['filing_no']}</b><br>Filed On<br><b>{us(d['date'])} {d['time']}</b><br>Number of Pages<br>1</div></div></div>
<div class="ttl">ARTICLES OF INCORPORATION</div>
<div class="sub">(PURSUANT TO {chapter}) &mdash; Profit Corporation</div>
<table>
<tr><td class="n">1. Name of Corporation</td><td><span class="val">{d['company'].upper()}</span></td></tr>
<tr><td class="n">2. Registered Agent for Service of Process</td><td>Commercial Registered Agent: <span class="val">{d['agent']}</span><br>{d['agent_addr']}</td></tr>
<tr><td class="n">3. Authorized Stock</td><td>Number of shares with par value: <span class="val">{d['shares']}</span> &nbsp; Par value per share: <span class="val">{d['par']}</span><br>Number of shares without par value: <span class="val">0</span></td></tr>
<tr><td class="n">4. Names and Addresses of the Board of Directors</td><td>{directors}</td></tr>
<tr><td class="n">5. Purpose</td><td>The purpose of the corporation shall be: any lawful activity for which a corporation may be organized under the laws of the State of {st}.</td></tr>
<tr><td class="n">6. Name, Address and Signature of Incorporator</td><td><span class="val">{d['incorporator']}</span>, {d['incorporator_addr']}<div style="display:flex;gap:20px;margin-top:6px"><div style="flex:1"><div class="sigbox">{sig(d['incorporator'])}</div><div class="sigline">Incorporator Signature</div></div><div style="width:1.6in"><div class="sigbox" style="font-family:'Liberation Mono';padding-top:12px">{us(d['signed'])}</div><div class="sigline">Date</div></div></div></td></tr>
<tr><td class="n">7. Certificate of Acceptance of Appointment of Registered Agent</td><td>I hereby accept appointment as Registered Agent for the above named entity.<div style="display:flex;gap:20px;margin-top:6px"><div style="flex:1"><div class="sigbox">{sig(d['agent_signer'])}</div><div class="sigline">Authorized Signature of Registered Agent &mdash; {d['agent_signer']}</div></div><div style="width:1.6in"><div class="sigbox" style="font-family:'Liberation Mono';padding-top:12px">{us(d['signed'])}</div><div class="sigline">Date</div></div></div></td></tr>
</table>
<p style="margin-top:14px">I, {sos}, Secretary of State of the State of {st}, do hereby certify that the foregoing is a true and complete copy of the Articles of Incorporation of <b>{d['company'].upper()}</b> as filed in this office on {long_date(d['date'])}.</p>
<div style="display:flex;justify-content:flex-end;margin-top:4px"><div style="width:2.8in;text-align:center"><div class="sigbox">{sig(sos)}</div><div class="sigline">{sos}, Secretary of State</div></div></div>
<div class="foot"><span>This form must be accompanied by appropriate fees.</span><span>{d['form_id']}</span></div>
</div>"""
    return html(body, FORM_CSS)


CA_CSS = """
.ca { font-family: 'P052'; font-size: 13px; line-height: 1.5; padding: 0.6in 0.9in; }
.ca .endorsed { position: absolute; top: 0.55in; right: 0.7in; width: 2.3in; text-align: center; border: 2px solid #3d3d8f; color: #3d3d8f; font-family: 'Liberation Sans'; font-size: 10px; line-height: 1.35; padding: 6px; transform: rotate(-1.5deg); }
.ca .endorsed .big { font-size: 14px; font-weight: bold; letter-spacing: 1px; }
.ca .entity { font-family: 'Liberation Sans'; font-size: 11px; margin-top: 4px; }
.ca h1 { text-align: center; font-size: 19px; letter-spacing: 2px; margin: 1.35in 0 4px; }
.ca h2 { text-align: center; font-size: 15px; margin: 0 0 16px; font-weight: normal; }
.ca p { margin: 0 0 10px; text-align: justify; }
.ca .num { font-weight: bold; }
"""


def ca_coi(d):
    seal = seal_svg("SECRETARY OF STATE • STATE OF CALIFORNIA •", "", color="#3d3d8f", size=92)
    body = f"""<div class="page ca">
<div style="position:absolute;top:0.55in;left:0.9in;display:flex;gap:10px;align-items:center">{seal_svg('STATE OF CALIFORNIA •', '', color='#3d3d8f', size=60)}<div style="font-family:Liberation Sans;font-size:11px;color:#3d3d8f">Secretary of State<br>State of California<br>Business Programs Division</div></div>
<div class="endorsed"><div class="big">ENDORSED &mdash; FILED</div>in the office of the Secretary of State<br>of the State of California<div class="big" style="margin-top:3px">{MONTHS[ymd(d['date'])[1]-1][:3].upper()} {ymd(d['date'])[2]:02d} {ymd(d['date'])[0]}</div><div class="entity">Entity No. {d['entity_no']}</div></div>
<h1>ARTICLES OF INCORPORATION</h1><h2>of<br><b>{d['company'].upper()}</b></h2>
<p><span class="num">I.</span> The name of this corporation is {d['company'].rstrip(".")}.</p>
<p><span class="num">II.</span> The purpose of the corporation is to engage in any lawful act or activity for which a corporation may be organized under the General Corporation Law of California other than the banking business, the trust company business or the practice of a profession permitted to be incorporated by the California Corporations Code.</p>
<p><span class="num">III.</span> The street address and mailing address of the corporation's initial principal office is {d['office']}.</p>
<p><span class="num">IV.</span> The name of the corporation's initial agent for service of process in California is {d['agent']}, {d['agent_addr']}.</p>
<p><span class="num">V.</span> This corporation is authorized to issue only one class of shares of stock, and the total number of shares which this corporation is authorized to issue is {d['shares']}.</p>
<p><span class="num">VI.</span> The liability of the directors of the corporation for monetary damages shall be eliminated to the fullest extent permissible under California law.</p>
<p style="margin-top:16px">IN WITNESS WHEREOF, the undersigned incorporator has executed these Articles of Incorporation on {long_date(d['signed'])}.</p>
<div style="width:3.2in;margin-left:auto;margin-top:10px"><div style="height:32px"><div class="sig">{d['incorporator']}</div></div><div class="sigline">{d['incorporator']}, Incorporator</div></div>
<div style="position:absolute;left:0.9in;right:0.9in;bottom:0.5in;display:flex;gap:14px;align-items:center;border-top:1px solid #3d3d8f;padding-top:8px;font-size:11px">
<div style="width:92px;height:92px">{seal}</div>
<div style="flex:1">I, ROSALIND K. WHITCOMBE, Secretary of State of the State of California, hereby certify that this copy of the Articles of Incorporation of {d['company'].upper()}, consisting of 1 page, is a true and correct copy of the original filed in this office on {long_date(d['date'])}.</div>
<div style="width:2.1in;text-align:center"><div style="height:30px"><div class="sig" style="font-size:23px">Rosalind K. Whitcombe</div></div><div class="sigline">Rosalind K. Whitcombe, Secretary of State</div></div></div>
</div>"""
    return html(body, CA_CSS)


# ---------------------------------------------------------------- IRS CP 575-style letters

CP_CSS = """
.cp { font-family: 'Liberation Sans'; font-size: 11.3px; line-height: 1.38; padding: 0.55in 0.7in; }
.cp .top { display: flex; justify-content: space-between; }
.cp .irs { display: flex; gap: 10px; }
.cp .irs .eagle { width: 46px; height: 46px; border: 2px solid #111; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-family: 'Nimbus Roman'; font-weight: bold; font-size: 15px; }
.cp .meta { width: 3.25in; font-size: 11px; }
.cp .meta td { padding: 1px 0; vertical-align: top; }
.cp .meta td:first-child { padding-right: 6px; }
.cp .addr { margin: 26px 0 18px 0.35in; text-transform: uppercase; line-height: 1.35; }
.cp h1 { font-size: 13px; text-align: center; margin: 12px 0; letter-spacing: .5px; }
.cp p { margin: 0 0 9px; text-align: justify; }
.cp .stub { border-top: 1.5px dashed #444; margin-top: 18px; padding-top: 10px; font-size: 10.6px; }
.cp .foot { position: absolute; bottom: 0.42in; left: 0.7in; right: 0.7in; display: flex; justify-content: space-between; font-size: 9.5px; }
.cp .odd { font-family: 'C059'; font-weight: bold; font-size: 15.5px; letter-spacing: .2px; }
.cp .odd2 { font-family: 'URW Bookman'; font-size: 14.5px; font-style: italic; }
"""


def cp575(d):
    name = d["company"]
    ein = d["ein"]
    notice = us(d["date"], "-")
    odd = d.get("odd_fonts")
    name_html = f"<span class='odd'>{name.upper()}</span>" if odd else name.upper()
    ein_meta = ein
    if d.get("pasted_ein"):
        ein_meta = f"<span class='pasted'>{ein}</span>"
    elif odd:
        ein_meta = f"<span class='odd2'>{ein}</span>"
    ein_body = f"<span class='odd2'>{ein}</span>" if odd else ein
    form = d["form"]
    y, _, _ = ymd(d["date"])
    due = d["due"]
    stub_ein = d.get("stub_ein", ein)
    addr = "<br>".join([name_html] + [a.upper() for a in d["addr"]])
    page1 = f"""<div class="page cp">
<div class="top"><div class="irs"><div class="eagle">IRS</div><div>Department of the Treasury<br>Internal Revenue Service<br>Cincinnati OH 45999</div></div>
<table class="meta"><tr><td>Date of this notice:</td><td>{notice}</td></tr>
<tr><td>Employer Identification Number:</td><td><b>{ein_meta}</b></td></tr>
<tr><td>Form:</td><td>SS-4</td></tr><tr><td>Number of this notice:</td><td>CP 575 {d['variant']}</td></tr>
<tr><td colspan="2" style="padding-top:6px">For assistance you may call us at:<br>1-800-829-4933</td></tr>
<tr><td colspan="2" style="padding-top:6px">IF YOU WRITE, ATTACH THE<br>STUB AT THE END OF THIS NOTICE.</td></tr></table></div>
<div class="addr">{addr}</div>
<h1>WE ASSIGNED YOU AN EMPLOYER IDENTIFICATION NUMBER</h1>
<p>Thank you for applying for an Employer Identification Number (EIN). We assigned you EIN {ein_body}. This EIN will identify you, your business accounts, tax returns, and documents, even if you have no employees. Please keep this notice in your permanent records.</p>
<p>When filing tax documents, payments, and related correspondence, it is very important that you use your EIN and complete name and address exactly as shown above. Any variation may cause a delay in processing, result in incorrect information in your account, or even cause you to be assigned more than one EIN. If the information is not correct as shown above, please make the correction using the attached tear off stub and return it to us.</p>
<p>Based on the information received from you or your representative, you must file the following form(s) by the date(s) shown.</p>
<table style="margin:0 0 10px 0.6in;font-size:11.3px"><tr><td style="width:2.2in">Form {form}</td><td>{due}</td></tr></table>
<p>If you have questions about the form(s) or the due date(s) shown, you can call us at the phone number or write to us at the address shown at the top of this notice. If you need help in determining your annual accounting period (tax year), see Publication 538, <i>Accounting Periods and Methods</i>.</p>
<p>We assigned you a tax classification based on information obtained from you or your representative. It is not a legal determination of your tax classification, and is not binding on the IRS. If you want legal determination of your tax classification, you may request a private letter ruling from the IRS under the guidelines in Revenue Procedure 2004-1, 2004-1 I.R.B. 1 (or superseding Revenue Procedure for the year at issue).</p>
<p><b>IMPORTANT REMINDERS:</b></p>
<p>* Keep a copy of this notice in your permanent records. This notice is issued only one time and the IRS will not be able to generate a duplicate copy for you. You may give a copy of this document to anyone asking for proof of your EIN.</p>
<p>* Use this EIN and your name exactly as they appear at the top of this notice on all your federal tax forms.</p>
<p>* Refer to this EIN on your tax-related correspondence and documents.</p>
<div class="foot"><span>(IRS USE ONLY) &nbsp; 575{d['variant']} &nbsp; {notice} &nbsp; {name.upper()[:4]} &nbsp; O &nbsp; 9999999999 &nbsp; SS-4</span><span>Page 1</span></div>
</div>"""
    page2 = f"""<div class="page cp">
<p>If you were assigned a tax classification of {d['classification']}, you can continue to use this EIN. For more information about your tax classification and filing requirements, visit the IRS web site or refer to the instructions for Form {form}.</p>
<p>Your name control associated with this EIN is {name.upper().replace(' ', '')[:4]}. You will need to provide this information, along with your EIN, if you file your returns electronically.</p>
<p>Thank you for your cooperation.</p>
<div style="text-align:right;margin-top:10px;font-size:10px">Keep this part for your records. &nbsp;&nbsp; CP 575 {d['variant']} (Rev. 7-2007)</div>
<div class="stub">
<div style="display:flex;justify-content:space-between"><span>Return this part with any correspondence<br>so we may identify your account. Please<br>correct any errors in your name or address.</span><span style="text-align:right">CP 575 {d['variant']}<br>9999999999</span></div>
<table style="margin-top:12px;font-size:10.6px"><tr><td style="width:3.2in">Your Telephone Number &nbsp; Best Time to Call</td><td>DATE OF THIS NOTICE: {notice}</td></tr>
<tr><td>(&nbsp;&nbsp;&nbsp;&nbsp;)&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;-</td><td>EMPLOYER IDENTIFICATION NUMBER: {stub_ein}<br>FORM: SS-4 &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; NOBOD</td></tr></table>
<div style="display:flex;justify-content:space-between;margin-top:18px;text-transform:uppercase"><span>INTERNAL REVENUE SERVICE<br>CINCINNATI OH 45999-0023</span><span>{'<br>'.join([name] + d['addr'])}</span></div>
</div>
<div class="foot"><span></span><span>Page 2</span></div>
</div>"""
    return html(page1 + page2, CP_CSS)


# ---------------------------------------------------------------- bank account letters

BANKS = {
    "cobalt": {"name": "Cobalt Ridge Bank, N.A.", "addr": "300 Cobalt Ridge Plaza, Suite 1400 &middot; Denver, CO 80202", "phone": "(303) 555-0148",
               "color": "#1f4e8c", "font": "Ubuntu", "officer": "Elaine M. Strathmore", "title": "Vice President, Business Banking", "routing": "102918734",
               "mark": "<svg width='44' height='44' viewBox='0 0 44 44'><polygon points='22,3 41,38 3,38' fill='#1f4e8c'/><polygon points='22,15 33,35 11,35' fill='#7fb0e8'/></svg>"},
    "silverbirch": {"name": "Silverbirch National Bank", "addr": "1180 Birchwood Avenue &middot; Minneapolis, MN 55402", "phone": "(612) 555-0193",
                    "color": "#2f5d46", "font": "C059", "officer": "Rafael T. Quenby", "title": "Assistant Vice President, Treasury Services", "routing": "091574426",
                    "mark": "<svg width='44' height='44' viewBox='0 0 44 44'><rect x='19' y='4' width='6' height='36' fill='#2f5d46'/><rect x='19' y='10' width='6' height='2' fill='#fff'/><rect x='19' y='19' width='6' height='2' fill='#fff'/><rect x='19' y='28' width='6' height='2' fill='#fff'/><circle cx='12' cy='14' r='7' fill='#7aa98c'/><circle cx='32' cy='20' r='8' fill='#7aa98c'/></svg>"},
    "northcairn": {"name": "Northcairn Savings Bank", "addr": "27 Cairn Street &middot; Portland, OR 97204", "phone": "(503) 555-0167",
                   "color": "#6b2f2f", "font": "URW Bookman", "officer": "Josephine A. Larkspur", "title": "Branch Manager, Commercial Accounts", "routing": "323271958",
                   "mark": "<svg width='44' height='44' viewBox='0 0 44 44'><ellipse cx='22' cy='37' rx='16' ry='5' fill='#6b2f2f'/><ellipse cx='22' cy='27' rx='12' ry='5' fill='#8f4a4a'/><ellipse cx='22' cy='18' rx='8' ry='4.5' fill='#6b2f2f'/><ellipse cx='22' cy='10' rx='5' ry='3.5' fill='#8f4a4a'/></svg>"},
}

BANK_CSS = """
.bk { font-size: 12.3px; line-height: 1.5; padding: 0.6in 0.85in; font-family: 'Liberation Serif'; }
.bk .lh { display: flex; align-items: center; gap: 12px; padding-bottom: 10px; }
.bk .lh .nm { font-size: 22px; font-weight: bold; }
.bk .lh .ad { font-family: 'Liberation Sans'; font-size: 9.8px; color: #444; }
.bk .rule { height: 3px; margin-bottom: 26px; }
.bk table.acct { border-collapse: collapse; margin: 10px 0 14px 0.25in; }
.bk table.acct td { padding: 3px 14px 3px 0; vertical-align: top; }
.bk table.acct td:first-child { font-weight: bold; width: 2.1in; }
.bk p { margin: 0 0 10px; text-align: justify; }
.bk .foot { position: absolute; left: 0.85in; right: 0.85in; bottom: 0.45in; font-family: 'Liberation Sans'; font-size: 8.6px; color: #555; border-top: 1px solid #bbb; padding-top: 5px; }
"""


def bank_letter(d):
    b = BANKS[d["bank"]]
    opened = long_date(d["date"])
    open_cell = opened
    if d.get("altered_open_from"):
        orig = long_date(d["altered_open_from"])
        open_cell = f"<span style='position:relative'>{orig}<span class='whiteout' style='left:5px;top:-2px;width:150px;white-space:nowrap;font-size:12.5px;transform:rotate(-1deg) translate(2px,1px)'>{opened}</span></span>"
    if d.get("no_signature"):
        sign = "<div style='height:44px'></div><div class='sigline' style='width:2.8in'>Authorized Signature</div><div style='height:16px'></div>"
    else:
        sign = f"<div style='height:40px'><div class='sig'>{b['officer']}</div></div><div class='sigline' style='width:2.8in'><b>{b['officer']}</b><br>{b['title']}<br>{b['name']}</div>"
    body = f"""<div class="page bk">
<div class="lh">{b['mark']}<div><div class="nm" style="font-family:'{b['font']}';color:{b['color']}">{b['name']}</div><div class="ad">{b['addr']} &middot; {b['phone']} &middot; Member FDIC</div></div></div>
<div class="rule" style="background:{b['color']}"></div>
<p>{long_date(d['letter_date'])}</p>
<p style="margin-top:16px"><b>RE: Bank Account Verification &mdash; {d['company']}</b></p>
<p>To Whom It May Concern:</p>
<p>At the request of our customer, {b['name']} confirms that the business deposit account described below is maintained with this institution and is open and in good standing as of the date of this letter.</p>
<table class="acct">
<tr><td>Account Holder (legal name)</td><td>{d['company']}</td></tr>
<tr><td>Business Address on File</td><td>{d['holder_addr']}</td></tr>
<tr><td>Account Type</td><td>{d['acct_type']}</td></tr>
<tr><td>Account Number</td><td>XXXXXX{d['last4']}</td></tr>
<tr><td>ABA Routing Number</td><td>{b['routing']}</td></tr>
<tr><td>Date Opened</td><td>{open_cell}</td></tr>
<tr><td>Account Status</td><td>Open &mdash; in good standing</td></tr>
<tr><td>Average Balance (90 days)</td><td>{d['balance']}</td></tr>
</table>
<p>The account has been maintained in a satisfactory manner since it was opened. There have been no returned items or overdrafts in the past twelve months. Authorized signers on the account are on file with the bank.</p>
<p>This letter is provided for verification purposes only at the request of the account holder and does not constitute a guarantee, credit reference or commitment to lend on the part of {b['name'].rstrip('.')}. Please contact the undersigned at {b['phone']} with any questions.</p>
<p style="margin-top:18px">Sincerely,</p>
{sign}
<div class="foot">{b['name']} &middot; Deposit products offered by {b['name']}. Member FDIC. Equal Housing Lender. This letter contains confidential account information intended only for the named recipient. Ref. {d['ref']}</div>
</div>"""
    return html(body, BANK_CSS)


# ---------------------------------------------------------------- the documents

DE_ISSUER = "State of Delaware, Secretary of State, Division of Corporations"
IRS_ISSUER = "Department of the Treasury, Internal Revenue Service, Cincinnati OH 45999"

DOCS = []


def doc(file, render, data, label):
    DOCS.append((file, render, data, label))


def de(company, date, **kw):
    data = {"company": company, "date": date, "time": "10:12 AM", "shares": "10,000,000", "par": "$0.0001", "signed": date, **kw}
    label = {"type": "certificate_of_incorporation", "company": company, "jurisdiction": "Delaware", "issuer": DE_ISSUER, "date": date}
    return data, label


# Delaware certificates
d, l = de("Bramblewick Tidal Instruments, Inc.", "2025-03-04", time="10:12 AM", sr="20250912384", file_no="7741902", auth="203381457",
          incorporator="Odile Fenwright", incorporator_addr="44 Quayside Lane, Portsmouth, NH 03801")
doc("coi-bramblewick-tidal-instruments.pdf", de_coi, d, {**l, "valid": True, "defects": []})
d, l = de("Quarry Lantern Software, Inc.", "2023-08-21", time="2:37 PM", sr="20233318806", file_no="7093315", auth="202917664",
          shares="15,000,000", par="$0.00001", incorporator="Callum Rothwyn", incorporator_addr="2211 Larkin Bend Road, Suite 4, Austin, TX 78704")
doc("coi-quarry-lantern-software.pdf", de_coi, d, {**l, "valid": True, "defects": []})
d, l = de("Quillmere Harbor Robotics, Inc.", "2025-06-02", time="9:47 AM", sr="20252290417", file_no="7810447", auth="203602118",
          shares="5,000,000", par="$0.001", body_company="Quillmere Harbour Robotic Systems, LLC", signed="2025-05-30",
          incorporator="Tamsin Okonkwo-Reyes", incorporator_addr="9 Larkspur Court, Burlington, VT 05401")
doc("coi-quillmere-harbor-robotics.pdf", de_coi, d, {**l, "body_company": "Quillmere Harbour Robotic Systems, LLC", "valid": False, "defects": [
    {"kind": "name_mismatch", "where": "title vs. Article FIRST",
     "detail": "The title and certification name Quillmere Harbor Robotics, Inc., but Article FIRST names Quillmere Harbour Robotic Systems, LLC, a different entity type and spelling."}]})
d, l = de("Ashgrove Vireo Labs, Inc.", "2024-09-30", time="3:05 PM", sr="20243104772", file_no="7562018", auth="203140995",
          altered_stamp_from="2024-07-15", cert_text_date="2024-07-15", signed="2024-07-15", shares="8,000,000",
          incorporator="Bettina Szarvas-Holm", incorporator_addr="31 Wexley Mews, Providence, RI 02903")
doc("coi-ashgrove-vireo-labs.pdf", de_coi, d, {**l, "valid": False, "defects": [
    {"kind": "altered_date", "where": "filing stamp, top right",
     "detail": "The Delivered and FILED dates in the stamp are covered with white-out and retyped as 09/30/2024 in a different typewriter font, while the certification below still says the fifteenth day of July, 2024."}]})
d, l = de("Ferncastle Biotics, Inc.", "2027-02-17", time="11:26 AM", sr="20270641139", file_no="8023391", auth="204011873",
          signed="2027-02-16", shares="20,000,000", incorporator="Lowell Abernathy-Quist", incorporator_addr="610 Saltmarsh Road, Wilmington, NC 28403")
doc("coi-ferncastle-biotics.pdf", de_coi, d, {**l, "valid": False, "defects": [
    {"kind": "future_date", "where": "filing stamp and certification",
     "detail": "The certificate says it was filed on February 17, 2027 and signed February 16, 2027, after the review date of October 30, 2026."}]})
d, l = de("Brisklow Marine Coatings, Inc.", "2023-04-11", time="11:05 AM", sr="20231409238", file_no="7012664", auth="202804356",
          shares="12,000,000", incorporator="Ingrid Mallory-Achebe", incorporator_addr="760 Ballast Point Drive, Norfolk, VA 23510")
doc("kyb-brisklow-coi.pdf", de_coi, d, {**l, "valid": True, "defects": []})

# Form-style state articles
WY = {"state": "Wyoming", "sos": "Theodora P. Vanlandt", "office_addr": "Herschler Building East, Cheyenne, WY 82002", "chapter": "W.S. 17-16-202",
      "form_id": "WY-SOS-PCorp-Articles Rev. 2021"}
NV = {"state": "Nevada", "sos": "Desmond R. Halloway", "office_addr": "Capitol Complex, Carson City, NV 89701", "chapter": "NRS CHAPTER 78",
      "form_id": "Nevada Secretary of State NRS 78 Articles Revised: 2023"}
doc("coi-marrowfield-bakeworks.pdf", form_coi, {**WY, "company": "Marrowfield Bakeworks Corp.", "date": "2022-11-09", "time": "08:52:14 AM", "signed": "2022-11-07",
    "business_no": "2022-001187342", "filing_no": "WY-PC-20221109-0412", "agent": "Prairie Line Registered Agents, Inc.", "agent_addr": "1712 Pioneer Avenue, Suite 9, Cheyenne, WY 82001",
    "agent_signer": "Garrick O. Sundqvist", "shares": "1,000,000", "par": "$0.01", "directors": [("Hollis Marrowfield", "88 Wheatgrass Lane, Laramie, WY 82070"), ("Annika Brosseau", "88 Wheatgrass Lane, Laramie, WY 82070")],
    "incorporator": "Hollis Marrowfield", "incorporator_addr": "88 Wheatgrass Lane, Laramie, WY 82070"},
    {"type": "certificate_of_incorporation", "company": "Marrowfield Bakeworks Corp.", "jurisdiction": "Wyoming", "issuer": "State of Wyoming, Secretary of State", "date": "2022-11-09", "valid": True, "defects": []})
doc("coi-tessaline-freight-systems.pdf", form_coi, {**NV, "company": "Tessaline Freight Systems, Inc.", "date": "2024-06-12", "time": "09:31:00 AM", "signed": "2024-06-10",
    "business_no": "NV20242187654", "filing_no": "20244123456", "agent": "Sagebrush Statutory Agents LLC", "agent_addr": "401 Ryland Street, Suite 200-A, Reno, NV 89502",
    "agent_signer": "Corinne D. Waltham", "shares": "75,000,000", "par": "$0.001", "directors": [("Marcus Tessaline", "5120 Dry Creek Parkway, Sparks, NV 89436"), ("Yevgenia Pardoe", "5120 Dry Creek Parkway, Sparks, NV 89436")],
    "incorporator": "Marcus Tessaline", "incorporator_addr": "5120 Dry Creek Parkway, Sparks, NV 89436"},
    {"type": "certificate_of_incorporation", "company": "Tessaline Freight Systems, Inc.", "jurisdiction": "Nevada", "issuer": "State of Nevada, Secretary of State", "date": "2024-06-12", "valid": True, "defects": []})
doc("coi-calloway-pinnacle-mining.pdf", form_coi, {**NV, "company": "Calloway Pinnacle Mining, Inc.", "date": "2025-08-26", "time": "02:14:47 PM", "signed": "2025-08-25",
    "business_no": "NV20251633078", "filing_no": "20255509187", "agent": "Sagebrush Statutory Agents LLC", "agent_addr": "401 Ryland Street, Suite 200-A, Reno, NV 89502",
    "agent_signer": "Corinne D. Waltham", "shares": "200,000,000", "par": "$0.0001", "directors": [("Thaddeus Calloway", "77 Silver Peak Road, Tonopah, NV 89049")],
    "incorporator": "Thaddeus Calloway", "incorporator_addr": "77 Silver Peak Road, Tonopah, NV 89049", "no_seal": True, "no_signature": True},
    {"type": "certificate_of_incorporation", "company": "Calloway Pinnacle Mining, Inc.", "jurisdiction": "Nevada", "issuer": "State of Nevada, Secretary of State", "date": "2025-08-26", "valid": False, "defects": [
        {"kind": "missing_seal", "where": "filing stamp box, top right", "detail": "The filing stamp has an empty space where the Secretary of State's seal belongs; no seal is printed or embossed."},
        {"kind": "missing_signature", "where": "items 6 and 7 and the certification", "detail": "The incorporator, registered agent and Secretary of State signature lines are all blank."}]})
doc("coi-wrenfield-acoustics.pdf", ca_coi, {"company": "Wrenfield Acoustics, Inc.", "date": "2021-05-17", "signed": "2021-05-12", "entity_no": "4721836",
    "office": "1450 Harrow Street, Suite 310, Oakland, CA 94607", "agent": "Delphine Wrenfield", "agent_addr": "1450 Harrow Street, Suite 310, Oakland, CA 94607",
    "shares": "10,000,000", "incorporator": "Delphine Wrenfield"},
    {"type": "certificate_of_incorporation", "company": "Wrenfield Acoustics, Inc.", "jurisdiction": "California", "issuer": "State of California, Secretary of State", "date": "2021-05-17", "valid": True, "defects": []})


# CP 575 letters
def ein_doc(file, company, date, ein, addr, form, due, classification, variant="A", valid=True, defects=None, **kw):
    doc(file, cp575, {"company": company, "date": date, "ein": ein, "addr": addr, "form": form, "due": due, "classification": classification, "variant": variant, **kw},
        {"type": "ein_letter", "company": company, "jurisdiction": "United States (federal)", "issuer": IRS_ISSUER, "date": date, "ein": ein,
         "valid": valid, "defects": defects or []})


CORP = "Corporation"
ein_doc("ein-quarry-lantern-software.pdf", "Quarry Lantern Software, Inc.", "2023-09-05", "92-3381047", ["2211 Larkin Bend Rd Ste 4", "Austin, TX 78704"], "1120", "03/15/2024", CORP)
ein_doc("ein-osterby-orchard-supply.pdf", "Osterby Orchard Supply LLC", "2024-02-14", "93-2216485", ["8820 Fenwick Orchard Rd", "Hood River, OR 97031"], "1065", "03/15/2025", "Partnership", variant="B")
ein_doc("ein-pellucid-harbor-analytics.pdf", "Pellucid Harbor Analytics, Inc.", "2025-01-22", "99-4057721", ["14 Wharfside Row Ste 3", "Portland, ME 04101"], "1120", "04/15/2026", CORP)
ein_doc("ein-dunmore-kiln-works.pdf", "Dunmore Kiln Works Corp.", "2022-07-11", "88-2973064", ["402 Clayhollow Rd", "Asheville, NC 28806"], "1120", "04/18/2023", CORP)
ein_doc("ein-hollowmere-textiles.pdf", "Hollowmere Textiles, Inc.", "2024-10-08", "85-3149906", ["19 Loomworks Way", "Fall River, MA 02720"], "1120", "04/15/2025", CORP,
        stub_ein="85-3149960", pasted_ein=True, valid=False, defects=[
            {"kind": "pasted_field", "where": "Employer Identification Number, top right",
             "detail": "The EIN in the header sits on a separate tinted patch with a drop shadow and a tilt, pasted over the original field; the tear-off stub on page 2 shows a different number, 85-3149960."}])
ein_doc("ein-vantablue-logistics.pdf", "Vantablue Logistics LLC", "2025-04-29", "33-4718250", ["2600 Riverport Dr Bldg C", "Memphis, TN 38109"], "1065", "03/16/2026", "Partnership", variant="B",
        odd_fonts=True, valid=False, defects=[
            {"kind": "inconsistent_fonts", "where": "addressee name and EIN",
             "detail": "The entity name and the EIN are set in a large bold serif and an italic serif, unlike the plain sans-serif used for every other line of the notice."}])
ein_doc("kyb-brisklow-ein.pdf", "Brisklow Marine Coatings, Inc.", "2023-05-02", "92-1658830", ["760 Ballast Point Dr", "Norfolk, VA 23510"], "1120", "04/15/2024", CORP)


# Bank letters
def bank_doc(file, bank, company, opened, letter_date, holder_addr, last4, ref, valid=True, defects=None, label_company=None, **kw):
    doc(file, bank_letter, {"bank": bank, "company": company, "date": opened, "letter_date": letter_date, "holder_addr": holder_addr, "last4": last4, "ref": ref,
                            "acct_type": kw.pop("acct_type", "Business Checking"), "balance": kw.pop("balance", "Mid five figures"), **kw},
        {"type": "bank_letter", "company": label_company or company, "jurisdiction": "United States", "issuer": BANKS[bank]["name"], "date": opened,
         "valid": valid, "defects": defects or []})


bank_doc("bank-bramblewick-tidal-instruments.pdf", "cobalt", "Bramblewick Tidal Instruments, Inc.", "2025-04-02", "2026-09-14", "44 Quayside Lane, Portsmouth, NH 03801", "4821", "CRB-VL-2026-091447", balance="Low six figures")
bank_doc("bank-tessaline-freight-systems.pdf", "silverbirch", "Tessaline Freight Systems, Inc.", "2024-07-01", "2026-08-27", "5120 Dry Creek Parkway, Sparks, NV 89436", "0937", "SNB-AV-26-08-2711", acct_type="Business Analyzed Checking", balance="Mid six figures")
bank_doc("bank-osterby-orchard-supply.pdf", "northcairn", "Osterby Orchard Supply LLC", "2024-03-04", "2026-10-06", "8820 Fenwick Orchard Road, Hood River, OR 97031", "2264", "NSB-1006-3381")
bank_doc("bank-ashgrove-vireo-labs.pdf", "cobalt", "Ashgrove Vireo Labs, Inc.", "2024-10-21", "2026-09-30", "31 Wexley Mews, Providence, RI 02903", "7730", "CRB-VL-2026-093012",
         no_signature=True, valid=False, defects=[
             {"kind": "missing_signature", "where": "signature block, bottom",
              "detail": "The letter ends at 'Sincerely,' over a blank signature line marked only 'Authorized Signature', with no signer named and no title."}])
bank_doc("bank-quorvane-medical-devices.pdf", "silverbirch", "Quorvane Medical Devices, Inc.", "2025-02-11", "2026-10-12", "2300 Bayfront Commons, Suite 120, Tampa, FL 33602", "5518", "SNB-AV-26-10-1204",
         altered_open_from="2025-11-02", balance="Low five figures", valid=False, defects=[
             {"kind": "altered_date", "where": "Date Opened row",
              "detail": "The Date Opened value is covered with white-out and retyped as February 11, 2025 in a typewriter font, slightly tilted, with the original text showing at the edges."}])
bank_doc("kyb-brisklow-bank.pdf", "northcairn", "Brisklow Marine Coatings, Inc.", "2023-06-15", "2026-10-20", "760 Ballast Point Drive, Norfolk, VA 23510", "6042", "NSB-1020-5527", balance="Low six figures")
bank_doc("kyb-brisklow-bank-mismatch.pdf", "northcairn", "Brisklow Marine Holdings LLC", "2023-06-15", "2026-10-20", "760 Ballast Point Drive, Norfolk, VA 23510", "6042", "NSB-1020-5527", balance="Low six figures")

PACKETS = {
    "brisklow": {"company": "Brisklow Marine Coatings, Inc.", "jurisdiction": "Delaware",
                 "documents": ["kyb-brisklow-coi.pdf", "kyb-brisklow-ein.pdf", "kyb-brisklow-bank.pdf"], "expected": "approve"},
    "brisklow-mismatch": {"company": "Brisklow Marine Coatings, Inc.", "jurisdiction": "Delaware",
                          "documents": ["kyb-brisklow-coi.pdf", "kyb-brisklow-ein.pdf", "kyb-brisklow-bank-mismatch.pdf"], "expected": "review",
                          "note": "The bank letter's account holder is Brisklow Marine Holdings LLC, a different entity from the applicant."},
}


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent).resolve()
    out.mkdir(parents=True, exist_ok=True)
    labels = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True)
        page = browser.new_page()
        for file, render, data, label in DOCS:
            page.set_content(render(data), wait_until="load")
            page.evaluate("document.fonts.ready")
            page.pdf(path=str(out / file), format="Letter", print_background=True, margin={"top": "0", "right": "0", "bottom": "0", "left": "0"})
            pages = page.evaluate("document.querySelectorAll('.page').length")
            entry = {"file": file, **label, "pages": pages}
            labels.append(entry)
            print(f"{file}: {pages} page(s)")
        browser.close()
    (out / "labels.json").write_text(json.dumps({"as_of": AS_OF, "documents": labels, "packets": PACKETS}, indent=2) + "\n")


if __name__ == "__main__":
    main()
