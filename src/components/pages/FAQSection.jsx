import { useState, memo } from "react";
import { useApp } from "../../context/AppContext";
import { AsclepiusIcon } from "../shared/Icons";
import { BILLING_CATALOG } from "../../../supabase/functions/_shared/billingCatalog.mjs";

const coreAnnual = BILLING_CATALOG.offers.core.unitAmount / 100;
const locumAnnual = BILLING_CATALOG.offers.core_locum.unitAmount / 100;

const FAQ_DATA = [
  {
    category: "Pricing & Billing",
    items: [
      {
        q: "Is CredentialDOMD free right now?",
        a: "Yes. The app is in beta and free while the beta lasts; billing is switched off. The plan names below describe what pricing is expected to look like later. If paid plans launch you will hear about it in advance, and nothing is charged without your agreement.",
      },
      {
        q: "Is there a permanent free plan?",
        a: "The current free access is an invite-only beta. CredentialDoMD is preparing two annual founding-member bundles; there is no permanent free plan or automatic upgrade.",
      },
      {
        q: "When will paid plans start?",
        a: "No paid launch date is set. Billing remains off while checkout, account migration and launch preparation are completed. You will receive advance notice and must agree before any charge.",
      },
      {
        q: "Can I deduct CredentialDoMD on my taxes?",
        a: "Core + Locum includes an expense ledger and an export for your tax professional. Ask them whether a subscription or any recorded expense is deductible in your circumstances.",
      },
      {
        q: "What are the planned founding-member prices?",
        a: `Core is planned at $${coreAnnual} per physician per year. Core + Locum is planned at $${locumAnnual} per physician per year. Billing is off; these are future annual offers, with no monthly plan or automatic conversion.`,
      },
      {
        q: "What does Core + Locum add?",
        a: "Core covers credentials, CME tracking, document scans, credential packets, CVs and the assistant. Core + Locum adds contracts, work logs, invoices, payment tracking and locums finance tools. Review extracted contract rates before using them, and record payments to track the remaining balance.",
      },
      {
        q: "Are group plans available?",
        a: "The prepared launch offer has two individual annual founding-member bundles. Group and enterprise plans are not offered for purchase.",
      },
      {
        q: "Can I cancel anytime?",
        a: "There is no paid subscription to cancel during the beta. Renewal and cancellation terms will be shown before any future purchase.",
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
        a: "Go to More > Settings. Enter your full name and tap \"Find My NPI\". The app will search the NPPES registry and show matching providers. Select yourself to auto-fill your NPI, degree type (MD or DO), and practice state. Then add any additional states where you hold licenses.",
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
        a: "CredentialDOMD monitors all expiration dates and categorizes them: red (expired), orange (expiring within 30 days), amber (expiring within your lead time, default 90 days), and green (current). You can customize the lead time in Settings. Alerts appear on the home page under \"Action Required\" and can be sent via email, text, or browser notifications.",
      },
      {
        q: "Can I scan documents to add credentials?",
        a: "Yes. Go to the Scan tab, upload or photograph a credential document, and the AI will extract the relevant information (type, license number, dates, state, etc.) and pre-fill the form for you. AI is on for your account with no setup: the image goes to Google Gemini through our server under a shared key with a daily per-user limit. Add your own Gemini key in Settings to lift that limit; then the image goes to Google under your key instead. Upload the credential itself, never a patient record.",
      },
      {
        q: "How do I share credentials with a hospital or employer?",
        a: "There are two ways: (1) From any credential, tap the Send button to email, text, or copy that credential's details. (2) Go to the Send tab to search across all your credentials and share any of them. Shared credentials include your name, NPI, degree, and all relevant details in a formatted message.",
      },
    ],
  },
  {
    category: "CME Tracking",
    items: [
      {
        q: "How does CME compliance tracking work?",
        a: "CredentialDOMD computes compliance for all 50 states. When you add CME credits and tag them with topics (e.g., Pain Management, Ethics, Opioid Prescribing), the app cross-references your hours against each state's mandatory requirements, including total hours, category minimums, and topic-specific mandates.",
      },
      {
        q: "What is the Find CME feature?",
        a: "Find CME is a curated directory of 33 accredited CME providers. It shows you where to earn credits for your specific unmet topics. The \"For You\" view highlights providers that cover your compliance gaps. You can filter by pricing (free, paid, subscription), MATE Act compliance, state-specific courses, and DO dual credit.",
      },
      {
        q: "Does CredentialDOMD track the DEA MATE Act requirement?",
        a: "Yes. The MATE Act requires all DEA-registered practitioners to complete a one-time 8-hour training on substance use disorders. CredentialDOMD tracks this in your CME compliance, and the Find CME section has a MATE Act filter to show providers offering qualifying courses (several are free).",
      },
      {
        q: "How do I tag CME topics for state compliance?",
        a: "When adding or editing a CME entry, you'll see topic chips at the bottom. Topics required by your tracked states are highlighted at the top. Tap any topic to tag your CME with it. The compliance engine uses these tags to determine which state requirements your CME satisfies.",
      },
      {
        q: "Can I track CME for multiple states?",
        a: "Yes. In Settings, add all states where you hold licenses. CredentialDOMD will compute compliance for each state independently, showing you which requirements are met and which topics still need attention.",
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
        a: "Go to More > Data & Backup. You can export all your data as a JSON file, which you can save anywhere and import later to restore. You can also print a formatted summary of all credentials. Your data also syncs to the cloud under your account, but a JSON export is the copy you control, so take one now and then.",
      },
      {
        q: "Can I move my data to a new device?",
        a: "Sign in on the new device and your synced data loads from the cloud. The private note on a work entry lives only in the browser it was written in; to carry it over, export on the old device (More > Data & Backup > Export JSON) and import on the new one. A JSON export also restores everything else if you ever need it.",
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
        a: "Go to More > Settings and scroll to the Notifications section. Enable browser notifications (requires permission), and optionally set up email and text notifications. You can choose a check frequency (daily to monthly). Notifications auto-escalate as deadlines approach.",
      },
      {
        q: "What does auto-escalation mean?",
        a: "CredentialDOMD automatically increases notification frequency as deadlines get closer. For example, if you set weekly notifications, the app may send daily notifications when a credential is expiring within 30 days, and multiple per day when something has expired. This ensures critical expirations don't slip through.",
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
