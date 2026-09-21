import { useState, memo } from "react";
import { useApp } from "../../context/AppContext";
import { AsclepiusIcon } from "../shared/Icons";
import { MEMBERSHIP_COPY } from "../../content/membershipCopy";

const FAQ_DATA = [
  {
    category: "Pricing & Billing",
    items: [
      {
        q: "Is CredentialDOMD free right now?",
        a: `${MEMBERSHIP_COPY.availability} ${MEMBERSHIP_COPY.promisedBeta} ${MEMBERSHIP_COPY.lifetimePolicy}`,
      },
      {
        q: "Who gets free lifetime membership?",
        a: MEMBERSHIP_COPY.lifetimePolicy,
      },
      {
        q: "How do I start a paid membership?",
        a: MEMBERSHIP_COPY.availability,
      },
      {
        q: "Can I deduct CredentialDOMD on my taxes?",
        a: "Practice includes an expense ledger and an export for your tax professional. Ask them whether a subscription or any recorded expense is deductible in your circumstances.",
      },
      {
        q: "What are the annual membership prices?",
        a: `${MEMBERSHIP_COPY.credentialPrices} ${MEMBERSHIP_COPY.rateLock} ${MEMBERSHIP_COPY.fullPackage}`,
      },
      {
        q: "What does Practice add?",
        a: "Credential covers credentials, CME tracking, document scans, credential packets, CVs and the assistant. Practice adds contracts, work logs, invoices, payment tracking and locums finance tools. Review extracted contract rates before using them, and record payments to track the remaining balance.",
      },
      {
        q: "Will the Practice trial charge me automatically?",
        a: MEMBERSHIP_COPY.practiceTrial,
      },
      {
        q: "Are group plans available?",
        a: "Credential and Credential + Practice memberships are for one physician. Group and enterprise plans are not offered for purchase.",
      },
      {
        q: "Can I cancel anytime?",
        a: "Use Manage paid subscription to review and cancel renewal. If you chose a purchase during your historical free beta, use Manage scheduled membership before the first charge date to avoid that charge. If you never opted in, there is no charge and nothing to cancel. Your saved records remain available to read and export.",
      },
      {
        q: "Do you store my documents securely?",
        a: "Uploaded documents go to Supabase cloud storage. Access rules are designed to separate accounts; the operator has administrative access. AI features send the content you submit to the selected provider. Private notes are stored separately in your browser and can be included in manual exports. The app makes no HIPAA compliance claim and currently offers no BAA. See the Security and Privacy pages for details before uploading sensitive material.",
      },
    ],
  },
  {
    category: "Getting Started",
    items: [
      {
        q: "What is CredentialDOMD?",
        a: "CredentialDOMD is a physician credential management app that helps you track, organize, and share all your professional credentials in one place. It covers licenses, CME credits, hospital privileges, insurance, case logs, health records, education, work history, peer references, and more.",
      },
      {
        q: "Is my data stored securely?",
        a: "Records are cached in this browser for offline use and synced to Supabase under your account. Uploaded documents use cloud storage, with access rules designed to separate accounts. Private notes use separate local storage, are not encrypted by the app, and do not sync automatically; manual exports can include them. The operator has administrative access. Details are in More > Privacy and the public Security page.",
      },
      {
        q: "Does CredentialDOMD work offline?",
        a: "Mostly. The app reads from a local cache, so you can open it and view your credentials without a connection; changes sync to the cloud when you are back online. Sign-in, NPI Lookup (the NPPES registry via NLM Clinical Tables), AI features, and support tickets need a connection.",
      },
      {
        q: "How do I set up my profile?",
        a: "Open More > Setup > About you and check your name, degree and primary state. Review any NPI lookup match before importing it. Continue with Your licenses and Expiration dates, using the dates on your current documents. You can return to Setup later; the other app features remain available.",
      },
      {
        q: "What's the difference between MD and DO mode?",
        a: "Selecting DO enables AOA-specific CME categories (Category 1-A, 1-B, 2-A, 2-B), AOA national requirements tracking, dual-accredited provider filtering, and AOA board certification types. Selecting MD uses AMA PRA categories. You can switch at any time in Settings.",
      },
    ],
  },
  {
    category: "Licenses & Credentials",
    items: [
      {
        q: "What types of credentials can I track?",
        a: "CredentialDOMD tracks: state medical licenses, DEA registrations, controlled substance licenses, board certifications (ABMS and AOA), CME credits, hospital privileges, malpractice insurance, case logs, health records (vaccinations, TB tests, fit tests), education, work history, peer references, and malpractice claim history.",
      },
      {
        q: "How do expiration alerts work?",
        a: "Alerts use the dates saved on your records and your lead time in Settings. Review Action Required on Home. Browser alerts need permission and an open app. The email service checks dated credential records daily and sends according to your settings and changes to those records, subject to scheduling and mail delivery. Automatic text reminders are not available. The current email digest does not include CME-hour shortfalls.",
      },
      {
        q: "Can I scan documents to add credentials?",
        a: "Yes. Tap Add on a phone or Documents on a desktop to open Smart Scan, then choose Upload or Camera. Review the extracted type, number, state and dates against your document before saving. Scanning sends the supplied content to Google Gemini through shared service access with usage limits, or through your optional own key in Settings. Use the credential itself and keep patient records out of uploads. If analysis fails, check Documents first because the file may already be saved.",
      },
      {
        q: "How do I share credentials with a hospital or employer?",
        a: "Use a credential's share control to review and share its details. For a credential packet, use the packet tools and check the selected documents and recipient before sending. Shared information can include your profile details. A copy or a message opened in another app still needs to be sent by you; check the result of the sharing method you choose.",
      },
    ],
  },
  {
    category: "CME Tracking",
    items: [
      {
        q: "How does CME compliance tracking work?",
        a: "The tracker compares your saved CME entries with the rules on file for your tracked states and the renewal dates used by the calculation. Open Credentials > CME Credits > Compliance to check the counted dates, categories, topics and source links. Topic tags do not prove course eligibility, and some exceptions are described in notes rather than fully calculated. A completed bar is not a board decision or a guarantee of compliance. Confirm unclear requirements with the relevant board.",
      },
      {
        q: "What is the Find CME feature?",
        a: "Find CME is a directory with topic, pricing and credit filters. Its For You view uses the gaps calculated from your saved records. Check the provider's current course page for price, accreditation, credit category and whether a course meets the requirement you are addressing. A directory listing or a reachable link is not a verification of eligibility.",
      },
      {
        q: "Does CredentialDOMD track the DEA MATE Act requirement?",
        a: "The app includes MATE-related tracking and a Find CME filter to help organize relevant training. Its result depends on your entries and tags. Confirm your own eligibility, qualifying training and any alternative pathway against the DEA's current guidance before making an attestation; the app does not make that attestation for you.",
      },
      {
        q: "How do I tag CME topics for state compliance?",
        a: "When adding or editing a CME entry, use Topics Covered. Topics from the rules on file for your tracked states appear first. Select tags that match the actual course content, and check the date and credit category too. The calculator uses those fields; a matching tag alone does not establish that the board accepts the course.",
      },
      {
        q: "Can I track CME for multiple states?",
        a: "Yes. Add your licenses and check Licensed States in Settings. The app shows a separate calculation for each tracked state. Review the license and dates being counted, especially if you have multiple licenses or an unusual renewal cycle. Where the app asks whether a condition applies, keep Not sure until you can confirm it.",
      },
      {
        q: "How do I import a CME transcript?",
        a: "Open Credentials > CME Credits > Import transcript. Choose a PDF, CSV or XLSX file, or Paste text instead. Map columns if asked, then review the dates, categories, hours and topic tags. Duplicates start unticked. Choose Add to CME log only after the selected rows are correct. Individual certificates can be linked from Documents afterward.",
      },
    ],
  },
  {
    category: "CV Generator",
    items: [
      {
        q: "How does the CV generator work?",
        a: "Go to More > Generate CV. The app automatically builds a professional curriculum vitae from all your stored credential data. Choose from three templates: Clinical (standard for hospital credentialing), Academic (detailed for academic positions), and Locum Tenens (compact for locum assignments). You can copy the CV to your clipboard or print/save as PDF.",
      },
      {
        q: "What data is included in the generated CV?",
        a: "The CV includes: your profile header (name, degree, NPI, specialties), education & training, licenses & certifications, hospital privileges, professional liability insurance, CME summary with state compliance, surgical case log summary, work history, peer references, and health clearances. The template you choose determines which sections appear.",
      },
    ],
  },
  {
    category: "Data & Privacy",
    items: [
      {
        q: "How do I back up my data?",
        a: "Open More > Data & Backup > Export JSON Backup to save a copy of your loaded records. This readable file can include local private notes, so keep it somewhere you control. The Private notes section also has a separate Export to a file action. Cloud records sync under your account; local private notes do not sync automatically and are not part of the server's monthly backup.",
      },
      {
        q: "Can I move my data to a new device?",
        a: "Sign in on the new device to load synced records. To move private work notes, export them on the old device in More > Data & Backup and restore the file on the new one. Check the result before clearing the old browser or signing out. Before a JSON restore, export your current data: restoring can replace collections included in the file and update settings. Keep both exports until you have checked the result.",
      },
      {
        q: "Does CredentialDOMD share my data with anyone?",
        a: "Services process information needed to run the app: Clerk for sign-in, Supabase for records and files, Cloudflare for proxying, Resend for email, and the NPI lookup service. AI features send submitted content to Google or Anthropic using a shared service key or your optional own key. Sharing a packet sends selected information to its recipient. The operator has administrative access for support, and tickets may be processed by AI tooling. See More > Privacy for the full list and details.",
      },
      {
        q: "What happens if I clear my browser data?",
        a: "The local cache is wiped, and so is the on-device private vault (the private notes on work entries). Your synced credential data reloads from the cloud the next time you sign in. Keep a JSON export from Data & Backup if you want the vault notes to survive.",
      },
      {
        q: "Can I permanently delete all my data?",
        a: "Yes. Go to More > Data Rights > Delete All My Data. You'll need to type DELETE to confirm. This permanently removes all credentials, settings, documents, and history from this device, the cloud database, and file storage. We recommend exporting a backup first. This action cannot be undone. To close the sign-in account itself, email support@credentialdomd.com.",
      },
      {
        q: "Where can I find the Privacy Policy and Terms of Service?",
        a: "Go to More and you'll see Privacy, Terms, and Data Rights buttons near the bottom of the page. These documents explain how your data is handled, your rights, and the terms of using CredentialDOMD.",
      },
    ],
  },
  {
    category: "Credentialing Applications",
    items: [
      {
        q: "Why should I track work history and peer references?",
        a: "Every hospital credentialing application and CAQH ProView re-attestation requires your complete work history (usually 10+ years) and 3-5 peer references. Having this data stored in CredentialDOMD means you never have to look it up again. The CV generator also includes these sections automatically.",
      },
      {
        q: "Why track malpractice history?",
        a: "All credentialing applications require disclosure of any malpractice claims, whether settled, dismissed, or pending. Your answers must be consistent across every application. Storing this in CredentialDOMD ensures you have accurate, consistent data ready for every form.",
      },
      {
        q: "What is CAQH and why does it matter?",
        a: "CAQH ProView is a national credential repository that most hospitals and insurance companies require you to maintain. It requires re-attestation every 120 days. CredentialDOMD helps you keep all the data CAQH requires organized and up to date, so re-attestation is faster and easier.",
      },
      {
        q: "What is the NPI Lookup feature?",
        a: "In Settings, enter your name and tap \"Find My NPI.\" This searches the free NPPES (National Plan and Provider Enumeration System) registry by your name and state, then shows matching providers. Select yourself from the results and your NPI, degree, state, and other profile data are auto-filled. No API key is required.",
      },
    ],
  },
  {
    category: "Notifications",
    items: [
      {
        q: "How do I set up notifications?",
        a: "Open More > Settings, check your email, and set your lead time and reminder frequency. Enable Email reminders for expiration digests and allow browser notifications on this device if wanted. The service's scheduler and mail delivery determine whether email arrives. The text setting currently does not send automatic SMS. Use Get help if an expected email is missing after checking your settings and spam folder.",
      },
      {
        q: "What does auto-escalation mean?",
        a: "The in-app alert check can shorten its interval as deadlines approach while the app is open. The server email digest follows its own daily check, your saved frequency and changes to dated records; it does not promise multiple emails per day. A manual email or text action opens your messaging app and still requires you to send the message.",
      },
    ],
  },
  {
    category: "Locum Work & Support",
    items: [
      {
        q: "Where do I start with locum invoices?",
        a: "Open Practice > Contracts and add or review an agreement. Its rates and increment drive the work log. In Work, select that agreement, log work and review the billed amount. Use Invoice to select days and inspect the preview. Sending or Copy records the invoice and marks entries billed; Copy alone does not deliver it to the recipient. In Invoices, record full or partial payments yourself to track the remaining balance.",
      },
      {
        q: "My ticket submitted but I have no response. Where do I check?",
        a: "Open Get help > Your tickets and select the original ticket. Replies appear there and can also be emailed. If there are no replies yet, add useful details to that ticket with Send reply. Filing a ticket does not mean the issue is fixed, and no response time is guaranteed here. If you cannot sign in, email support@credentialdomd.com. Support may use AI assistance; you can ask for a human review.",
      },
    ],
  },
];

function FAQSection() {
  const { theme: T } = useApp();
  const [openIdx, setOpenIdx] = useState(null);
  const [searchQ, setSearchQ] = useState("");

  const toggle = (catIdx, itemIdx) => {
    const key = `${catIdx}-${itemIdx}`;
    setOpenIdx(openIdx === key ? null : key);
  };

  const filteredFAQ = searchQ.trim()
    ? FAQ_DATA.map(cat => ({
        ...cat,
        items: cat.items.filter(
          item =>
            item.q.toLowerCase().includes(searchQ.toLowerCase()) ||
            item.a.toLowerCase().includes(searchQ.toLowerCase())
        ),
      })).filter(cat => cat.items.length > 0)
    : FAQ_DATA;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <AsclepiusIcon size={22} color={T.accent} />
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>Help & FAQ</h2>
      </div>
      <p style={{ margin: "0 0 14px", fontSize: 13, color: T.textMuted }}>
        Answers to common questions about CredentialDOMD.
        {" "}<a href="/help" style={{ color: T.accent }}>Open step-by-step written guides</a>.
      </p>

      {/* Search */}
      <div style={{ position: "relative", marginBottom: 14 }}>
        <input
          value={searchQ}
          onChange={e => setSearchQ(e.target.value)}
          placeholder="Search FAQ..."
          data-desk-search=""
          style={{
            width: "100%", padding: "12px 16px", backgroundColor: T.input,
            border: `1px solid ${T.inputBorder}`, borderRadius: 10, color: T.text,
            fontSize: 14, outline: "none", boxSizing: "border-box",
          }}
        />
      </div>

      {filteredFAQ.length === 0 && (
        <div style={{ textAlign: "center", padding: "24px 16px", color: T.textDim, fontSize: 14 }}>
          No matching questions found. Try different search terms.
        </div>
      )}

      {filteredFAQ.map((cat, catIdx) => (
        <div key={cat.category} style={{ marginBottom: 16 }}>
          <div style={{
            fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase",
            letterSpacing: 0.8, marginBottom: 6, paddingLeft: 2,
          }}>
            {cat.category}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {cat.items.map((item, itemIdx) => {
              const key = `${catIdx}-${itemIdx}`;
              const isOpen = openIdx === key;
              return (
                <div key={itemIdx} style={{
                  backgroundColor: T.card, border: `1px solid ${isOpen ? T.accent : T.border}`,
                  borderRadius: 12, overflow: "hidden",
                  transition: "border-color 0.2s",
                }}>
                  <button
                    onClick={() => toggle(catIdx, itemIdx)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      width: "100%", padding: "14px 16px", background: "none", border: "none",
                      cursor: "pointer", textAlign: "left", gap: 8,
                    }}
                  >
                    <span style={{ fontSize: 14, fontWeight: 600, color: T.text, flex: 1 }}>{item.q}</span>
                    <span style={{
                      fontSize: 16, color: T.textDim, flexShrink: 0,
                      transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
                      transition: "transform 0.2s",
                    }}>{"\u25be"}</span>
                  </button>
                  {isOpen && (
                    <div style={{
                      padding: "0 16px 16px", fontSize: 13, color: T.textMuted,
                      lineHeight: 1.6, borderTop: `1px solid ${T.border}`,
                      paddingTop: 10, animation: "fadeIn 0.2s ease-out",
                    }}>
                      {item.a}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Footer */}
      <div style={{
        marginTop: 8, padding: "14px 16px", backgroundColor: T.card,
        border: `1px solid ${T.border}`, borderRadius: 14, textAlign: "center", boxShadow: T.shadow1,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 4 }}>Still have questions?</div>
        <div style={{ fontSize: 12, color: T.textDim }}>
          CredentialDOMD is built for physicians, by a physician. Email support@credentialdomd.com or use Get help in the app.
        </div>
      </div>
    </div>
  );
}

export default memo(FAQSection);
