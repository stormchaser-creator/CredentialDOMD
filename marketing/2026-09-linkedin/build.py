#!/usr/bin/env python3
"""Render KIT.md and kit.html from content.py. Run: python3 build.py"""
import html, json, pathlib
import content as c

here = pathlib.Path(__file__).parent
e = html.escape

# ---------- KIT.md ----------
md = ["# LinkedIn kit, September 2026", "",
      "Post as Eric Whitney, DO. Eric posts; nothing here is sent automatically. Source of truth is `content.py`; run `python3 build.py` after editing.", "",
      "Baseline measured 2026-09-21: 21 followers, 19 connections, 0 original posts, 6 invitations waiting, 0 LinkedIn referrals in 446 site hits. Done the same day: headline, About, Founder position, Texas post, and the src=li visit counting. House rule: no hyphens or dashes in any copy (bill and statute numbers excepted).", "",
      "## Headline", "", c.HEADLINE, "", "## About", "", c.ABOUT, "", "## Experience entry", "", c.EXPERIENCE, ""]
for p in c.POSTS:
    md += [f"## {p['week']}: {p['title']}", "", f"_{p['when']}_", ""]
    if p["flag"]: md += [f"**Before posting:** {p['flag']}", ""]
    md += ["```", p["body"], "```", "", "| Claim | Checked against | Link |", "|---|---|---|"]
    md += [f"| {a} | {b} | {u} |" for a, b, u in p["sources"]]
    md += [""]
(here / "KIT.md").write_text("\n".join(md))

# ---------- kit.html ----------
def copyblock(cid, label, text, note=""):
    return f'''<section class="block" aria-labelledby="{cid}-h">
  <div class="block-head"><h3 id="{cid}-h">{e(label)}</h3><span class="count">{len(text):,} chars</span></div>
  {note}
  <pre class="copytext" id="{cid}">{e(text)}</pre>
  <button class="copy" type="button" data-target="{cid}" id="{cid}-btn">Copy</button>
</section>'''

posts_html = []
for i, p in enumerate(c.POSTS, 1):
    flag = f'<p class="flag"><strong>Before posting.</strong> {e(p["flag"])}</p>' if p["flag"] else ""
    src = "".join(f'<li><span class="claim">{e(a)}</span><span class="basis">{e(b)}</span><a href="{e(u)}" target="_blank" rel="noopener">{e(u.split("//")[1])}</a></li>' for a, b, u in p["sources"])
    live = f'<p class="live">Live on LinkedIn. <a href="{e(p["posted"])}" target="_blank" rel="noopener">Open the post</a></p>' if p.get("posted") else ""
    note = f'{live}<p class="when">{e(p["when"])}</p>{flag}'
    posts_html.append(f'''<article class="post">
  <p class="eyebrow">{e(p["week"])}</p>
  {copyblock(f"post{i}", p["title"], p["body"], note)}
  <details><summary>What each claim was checked against</summary><ul class="sources">{src}</ul></details>
</article>''')

TEMPLATE = (here / "kit.template.html").read_text()
out = (TEMPLATE
  .replace("{{HEADLINE}}", copyblock("headline", "Headline", c.HEADLINE, '<p class="when">On your profile since 21 September. It replaced a headline that listed five identities and never named CredentialDOMD.</p>'))
  .replace("{{ABOUT}}", copyblock("about", "About", c.ABOUT, '<p class="when">On your profile since 21 September. Your original bio is kept in full below the new opening; the untouched original is saved as ABOUT-ORIGINAL-2026-09-21.txt. "More than one state license" is deliberately vague; make it exact if you like.</p>'))
  .replace("{{EXPERIENCE}}", copyblock("experience", "Experience entry", c.EXPERIENCE, '<p class="when">On your profile since 21 September, dated February 2026, the month of the first commit. Change the date if that is wrong.</p>'))
  .replace("{{POSTS}}", "\n".join(posts_html)))
(here / "kit.html").write_text(out)
print("wrote KIT.md and kit.html", len(out), "bytes")
