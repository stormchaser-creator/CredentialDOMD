# Single source for the LinkedIn kit. build.py renders KIT.md and kit.html from this.
HEADLINE = "Neurosurgeon, DO | Founder of CredentialDOMD | I publish the medical license renewal rules for all 50 states and DC, and built the tracker I wanted for my own licenses, DEA, boards and CME"

ABOUT = """I am a practicing neurosurgeon with more than one state license, a DEA registration, board certification and hospital privileges. Every one of them runs on a different clock. Colorado expires every physician on April 30 of odd numbered years. Texas assigns one of four fixed dates and picks the year by whether your license number is odd or even. Maine goes by the year you were born.

No spreadsheet knows any of that, so I built CredentialDOMD. It keeps licenses, DEA, board certification, privileges and CME in one place, with each state's rules built in. No patient data goes into it. I use it on my own credentials.

I also published a sourced renewal guide for every state and DC, free at credentialdomd.com/states. Here I post one renewal rule a week.

Founding membership is $99 a year for the first 100 paid members, with a no hassle 100% money back guarantee.

Board certified neurosurgeon practicing with Arrowhead Neurosurgical Medical Group across Eisenhower Health, Arrowhead Regional Medical Center, Riverside University Health System, and Desert Regional Medical Center in Southern California's Inland Empire and Coachella Valley.

I completed my neurosurgical residency at Arrowhead Regional Medical Center and my internship at Desert Regional Medical Center after graduating from Liberty University College of Osteopathic Medicine. I hold board certification from the American Osteopathic Board of Surgery in Neurosurgery.

My clinical work spans the full spectrum of neurosurgery: trauma, spine, cerebrovascular, and neurooncology. My research interests include traumatic brain injury, cerebral aneurysms, the neurological effects of music and binaural beats, and a soliton based framework for understanding consciousness loss in aneurysmal subarachnoid hemorrhage.

I also build tools at the intersection of clinical neuroscience and technology:

• The Decoded Human (thedecodedhuman.com): an AI powered literature connectome that discovers hidden semantic connections across open access scientific papers

• Still You Recovery (stillyourecovery.com): free patient education resources for the emotional and cognitive aftermath of brain surgery and stroke

• ANMG CallSync: a scheduling platform for multisite neuroscience on call coverage

I believe the mind and body are deeply interconnected, and that healing requires caring for both. My clinical, technological and intellectual work is guided by that conviction.

Open to: research collaborations, health technology partnerships, speaking invitations, and locums opportunities in neurosurgery."""

EXPERIENCE = """Title: Founder
Company: CredentialDOMD
Description: I built the credential tracker I wanted as a physician licensed in several states: licenses, DEA, board certification, privileges and CME in one place, with each state's renewal rules built in. I also publish free, sourced renewal guides for all 50 states and DC at credentialdomd.com/states"""

SIGNOFF = "I am a practicing neurosurgeon. I built CredentialDOMD and use it for my own credentials. Founding membership is $99 a year for the first 100 paid members, with a no hassle 100% money back guarantee."

POSTS = [
 dict(week="Week 1", when="Posted 21 September 2026. Answer every comment the same day.", posted="https://www.linkedin.com/feed/update/urn:li:activity:7507923901025509377/",
  title="Texas: CE Broker hard stop",
  flag=None,
  body=f"""Texas physicians: as of September 1, you cannot renew your license until your CME is in CE Broker.

The Texas Medical Board now requires it for every renewal on or after September 1, 2026. You need an active CE Broker account with your completed CME reported in it. The basic CE Broker account is free. If the board cannot verify your hours there, you cannot renew. A folder of certificates does not count until the hours are entered.

The next fixed expiration date is November 30.

Three other Texas rules that catch people:

Your expiration is not your birthday or your license anniversary. It is one of four dates (February 28, May 31, August 31, November 30), assigned when you were licensed. Even numbered licenses expire in even years, odd numbered in odd years. Two partners in the same practice can be on different clocks.

Online renewal opens 60 to 90 days before expiration. An application you start and leave is saved for 15 days. After that you start over.

There is a 30 day grace period. Then a $75 penalty, rising to $150 after 90 days. At one year expired the license is automatically cancelled, and there is no reinstatement by fee. You apply for a new license under whatever rules exist that day.

Full Texas guide with the board's sources: credentialdomd.com/states/texas?src=li

{SIGNOFF}""",
  sources=[
   ("CE Broker required from September 1, 2026; basic account free; cannot renew if TMB cannot verify", "TMB Continuing Education Tracking page, read live 21 Sep 2026", "https://www.tmb.texas.gov/resources/for-applicants-and-licensees/continuing-education-tracking"),
   ("Four dates; even/odd license numbers; 60 to 90 days; 15 day save; 30 day grace; $75 then $150 after 90 days; cancelled at one year", "TMB Physician Renewal page, read live 21 Sep 2026, every figure quoted verbatim", "https://www.tmb.texas.gov/apply-renew/physician/physician-renewal"),
   ("Independent confirmation of the September 1 rule", "TMLT and Texas Academy of Family Physicians notices", "https://www.tmlt.org/resource/new-cme-requirements-begin-september-1"),
  ]),
 dict(week="Week 2", when="Scheduled for Sunday 27 September 2026, one week after the Texas post.",
  title="Why a neurosurgeon built a license tracker",
  flag=None,
  body=f"""I opened the spreadsheet to answer what should have been a five second question: which of my licenses renews next?

I could not answer it.

Not because the dates were hard to find. Because the states do not agree on what a date is. One expires every physician in the state on one fixed day in odd numbered years, whether you were licensed twenty years ago or last spring. One uses my birthday. And the third is a DO license in a state where osteopathic physicians renew with an entirely different board than MDs do.

Three licenses, three unrelated clocks, and a spreadsheet that only knew what I typed into it.

So I made the thing I wanted. It holds the licenses, the DEA record, the board requirements and each state's CME rules in one place, and I use it on my own credentials.

Then I wrote up the renewal rules for all 50 states and DC, each one citing that board's own pages, and put them where anyone can read them free.

The part worth keeping even if you never click anything. I do not hold a Maine license. I read Maine's rules anyway. If you hold one, your renewal year follows the year you were born: born in an even year you renew in even years, born odd, odd. And Maine DOs do not renew with the MD board at all. Different board, different portal, 100 CME hours per cycle instead of 40.

I am a DO. Nobody tells you these things. You find them by looking.

The guides: credentialdomd.com/states?src=li

I built this. It is called CredentialDOMD. Founding membership is $99 a year for the first 100 paid members, with a no hassle 100% money back guarantee.""",
  sources=[
   ("Three licenses: California, North Dakota, Colorado", "Eric confirmed the three states on 21 Sep 2026. The earlier draft said four and put the Maine birth year clock in his own mouth; that was wrong and is removed.", "https://credentialdomd.com/states"),
   ("One fixed day in odd numbered years, whoever you are (Colorado)", "states[CO].renewalAnchor: \"All Physician and Pro Bono Physician licenses expire on April 30 of odd numbered years, regardless of when the license was issued.\" Colorado has one board for MDs and DOs, so it applies to him. Verified against more than one source.", "https://dpo.colorado.gov/Medical"),
   ("One uses my birthday (North Dakota)", "states[ND].renewalAnchor: \"Licenses expire on the physician's birthday every other year (effective August 1, 2023).\" The North Dakota Board of Medicine licenses MDs and DOs alike. Single source, which is why the post names no state.", "https://www.ndbom.org/practitioners/physicians/current/renew-reactivate-instruct.asp"),
   ("The third is a DO license renewed with a different board (California)", "states[CA].doBoardName is the Osteopathic Medical Board of California, separate from the Medical Board of California. The post deliberately does NOT state his California renewal date rule: the widely quoted \"month your license was issued\" anchor is the MD rule, and our own record says OMBC does not publish the DO anchor. Do not reinstate that line.", "https://www.ombc.ca.gov/"),
   ("Maine birth year parity; Maine DOs, 100 CME hours against 40", "states[ME] pitfalls and cmeDetails, checked field by field in marketing/2026-08-refresh/linkedin-01-founder-arc.md. Maine is verified against more than one source.", "https://credentialdomd.com/states/maine"),
   ("No count of how many states split MDs from DOs", "Deliberately omitted. A naive count of the doBoardName field gives 15, but Connecticut and Wisconsin hold prose in that field saying they have NO separate board, so the real figure from our data is 13 and the field cannot be trusted as a flag. Do not publish a number without checking each state.", "https://credentialdomd.com/states"),
   ("$99 founding rate and the money back guarantee", "Live wording on credentialdomd.com and its Terms, read 21 Sep 2026: \"No hassle 100% money back guarantee: a full refund of your most recent annual payment, at any time.\"", "https://credentialdomd.com/"),
  ]),
 dict(week="Week 3", when="Florida online renewal opens about 90 days before January 31, which is early November. This lands just ahead of it.",
  title="Florida: no grace period, $355 becomes $705 overnight",
  flag="The DO paragraph (March 31 of even years, $405, 1 hour Laws and Rules) comes from the August check against more than one source, not from today's live read. The MD figures were read again live today.",
  body=f"""Florida MDs in Group 2: your license expires January 31, 2027, and Florida has no grace period.

On February 1 the license is delinquent and the renewal fee goes from $355 to $705. After the board's 120 day delinquent notice it is $1,060.

Leave it delinquent through the end of the next cycle and the license becomes null and void, with no further action by the board and no reinstatement. You apply again as a new applicant.

Two things to check now instead of in January:

Which group you are in. Group 1 expires January 31 of even numbered years, Group 2 of odd numbered years. The board assigns the group. It has nothing to do with your birthday or when you were licensed, so your partner's year may not be yours. The expiration date printed on your license is the answer.

Whether your CME is in CE Broker. Florida confirms your hours there when you renew.

DOs are on a separate clock: every Florida DO license expires March 31 of even numbered years, the fee is $405, and there is a 1 hour Florida Laws and Rules requirement that MDs do not have.

Full Florida guide with the boards' sources: credentialdomd.com/states/florida?src=li

{SIGNOFF}""",
  sources=[
   ("$355, $705, $1,060; Group 1 even years, Group 2 odd years; delinquent status; null and void; CE Broker", "Florida Board of Medicine MD renewal page, read live 21 Sep 2026, figures quoted verbatim", "https://flboardofmedicine.gov/medical-doctor-renewal/"),
   ("DO date, fee and Laws and Rules hour", "Florida Board of Osteopathic Medicine renewal and fees pages, verified Aug 2026", "https://floridasosteopathicmedicine.gov/renewals/osteopathic-physician-renewal/"),
  ]),
 dict(week="Week 4", when="Colorado's April 30, 2027 renewal is the first one with mandatory CME. Seven months of lead time is the point of the post.",
  title="Colorado: the first renewal with mandatory CME",
  flag=None,
  body=f"""If you hold a Colorado medical license, 2027 is the first renewal in the state's history where CME is mandatory.

HB 24-1153 did it. For renewals on or after January 1, 2026, Colorado physicians owe 30 hours every two years, including 2 hours on substance use disorders, with board audits of up to 5 percent of physicians. The first physician renewal it touches is April 30, 2027.

The rest of the Colorado calendar, since most of it surprises people:

Every physician license in the state expires April 30 of odd numbered years. Not your birthday, not your license anniversary. If yours was issued partway through a cycle, your first renewal period is shorter than two years.

The renewal link does not appear in the state portal until roughly four to six weeks before expiration, so starting early is not an option.

There is a 60 day grace period after expiration under CRS 12-20-202(1)(e). Miss it and this stops being a late renewal: reinstatement wants a certified NPDB self query report, an FSMB disciplinary action report sent to DORA, license verifications from your other states and a practice history. Those reports take weeks to arrive.

Full Colorado guide with sources: credentialdomd.com/states/colorado?src=li

{SIGNOFF}""",
  sources=[
   ("Every Colorado claim", "Fact check on eleven points against states-data.json and the statute, in marketing/2026-08-refresh/linkedin-03-state-guide.md. Colorado is verified against more than one source.", "https://credentialdomd.com/states/colorado"),
  ]),
]
