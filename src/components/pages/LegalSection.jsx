import { useState, memo } from "react";
import { useApp } from "../../context/AppContext";
import { deleteAllData } from "../../lib/supabase";

function LegalSection({ page }) {
  const { data, setData, userIdRef, theme: T } = useApp();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");

  // Permanently delete all user data
  const handleDeleteAllData = () => {
    if (deleteInput !== "DELETE") return;
    // Clear from localStorage and Capacitor
    localStorage.removeItem("credentialdomd-data");
    try { if (window.storage?.remove) window.storage.remove("credentialdomd-data"); } catch {}
    // Clear from Supabase
    if (userIdRef?.current) {
      deleteAllData(userIdRef.current).catch(() => {});
    }
    setData({
      licenses: [], cme: [], privileges: [], caseLogs: [], insurance: [],
      healthRecords: [], education: [], documents: [], shareLog: [],
      notificationLog: [], workHistory: [], peerReferences: [], malpracticeHistory: [],
      settings: {
        primaryState: "CA", additionalStates: [], reminderLeadDays: 90,
        name: "", npi: "", degreeType: "DO", specialties: [],
        email: "", phone: "", theme: data.settings.theme, apiKey: "",
        notifyEmail: true, notifyText: true, notifyFreqDays: 7,
        lastNotified: null, alertsFingerprint: null, snoozedUntil: null,
      },
    });
    setShowDeleteConfirm(false);
    setDeleteInput("");
  };

  if (page === "privacy") return <PrivacyPolicy T={T} />;
  if (page === "terms") return <TermsOfService T={T} />;
  if (page === "data-rights") return (
    <DataRights
      T={T}
      showDeleteConfirm={showDeleteConfirm}
      setShowDeleteConfirm={setShowDeleteConfirm}
      deleteInput={deleteInput}
      setDeleteInput={setDeleteInput}
      handleDeleteAllData={handleDeleteAllData}
    />
  );
  return null;
}

function Disclaimer({ T }) {
  return (
    <div style={{
      padding: "12px 14px", backgroundColor: T.warningDim, border: `1px solid ${T.warning}`,
      borderRadius: 12, marginBottom: 16, fontSize: 13, lineHeight: 1.6, color: T.text,
    }}>
      <strong style={{ color: T.warning }}>Legal Disclaimer:</strong> This is a placeholder document and does NOT constitute legal advice. This document <strong>must be reviewed and customized by a qualified attorney</strong> before this application is deployed to real users. The developers of CredentialDOMD are not liable for the contents of this placeholder.
    </div>
  );
}

function Section({ title, children, T }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 8 }}>{title}</h3>
      <div style={{ fontSize: 13, lineHeight: 1.7, color: T.textMuted }}>{children}</div>
    </div>
  );
}

function PrivacyPolicy({ T }) {
  return (
    <div>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 700, color: T.text }}>Privacy Policy</h2>
      <p style={{ margin: "0 0 14px", fontSize: 12, color: T.textDim }}>Last updated: February 2026</p>
      <Disclaimer T={T} />

      <Section title="1. Data We Collect" T={T}>
        <p>CredentialDOMD collects and stores the following data that you voluntarily provide:</p>
        <ul style={{ paddingLeft: 18, marginTop: 4 }}>
          <li>Physician profile information (name, NPI, degree type, email, phone)</li>
          <li>Medical licenses, certifications, and registration details</li>
          <li>Continuing Medical Education (CME) records</li>
          <li>Hospital privilege and appointment records</li>
          <li>Professional liability insurance information</li>
          <li>Work history and peer references</li>
          <li>Malpractice claim history</li>
          <li>Health clearance records (vaccinations, TB tests, fit tests)</li>
          <li>Uploaded document images</li>
          <li>Education and training records</li>
        </ul>
      </Section>

      <Section title="2. How Your Data Is Stored" T={T}>
        <p>All data is stored <strong>locally on your device</strong> using your browser's localStorage. Your credential data is <strong>never transmitted to our servers</strong> because we do not operate any servers that receive or store your data.</p>
        <p style={{ marginTop: 6 }}>The only external services contacted are:</p>
        <ul style={{ paddingLeft: 18, marginTop: 4 }}>
          <li><strong>NPPES Registry</strong> (npiregistry.cms.hhs.gov) — for NPI lookup, a free public government API</li>
          <li><strong>Anthropic API</strong> (api.anthropic.com) — for AI document scanning, only when you provide your own API key and initiate a scan</li>
          <li><strong>Google Fonts</strong> (fonts.googleapis.com) — for loading the application typeface</li>
        </ul>
      </Section>

      <Section title="3. Data Sharing" T={T}>
        <p>We do not sell, rent, or share your data with any third party. When you use the Share/Send feature, credential information is composed into an email or text message on your device — we do not send it on your behalf or retain copies.</p>
      </Section>

      <Section title="4. Data Security" T={T}>
        <p>Your data is stored locally and is as secure as your device and browser. We recommend:</p>
        <ul style={{ paddingLeft: 18, marginTop: 4 }}>
          <li>Using a device with a passcode or biometric lock</li>
          <li>Not using CredentialDOMD on shared or public computers</li>
          <li>Regularly backing up your data using the Export feature</li>
          <li>Not sharing your API key with others</li>
        </ul>
      </Section>

      <Section title="5. HIPAA Considerations" T={T}>
        <p>CredentialDOMD stores physician credentialing data, which may include information adjacent to Protected Health Information (PHI). While this app is designed for personal use by the physician themselves (not for covered entities), users handling data in a clinical or institutional context should consult their compliance officer about applicable HIPAA requirements.</p>
        <p style={{ marginTop: 6 }}>Additional safeguards may be required for deployments involving institutional use, multi-user environments, or integration with covered entity systems.</p>
      </Section>

      <Section title="6. Your Rights" T={T}>
        <p>Because all data is stored locally on your device, you have full control:</p>
        <ul style={{ paddingLeft: 18, marginTop: 4 }}>
          <li><strong>Access:</strong> All your data is visible within the app at all times</li>
          <li><strong>Export:</strong> Use Data & Backup to download all your data as JSON</li>
          <li><strong>Delete:</strong> Use the Data Rights page to permanently delete all your data</li>
          <li><strong>Portability:</strong> Exported JSON files can be imported into any compatible system</li>
        </ul>
      </Section>

      <Section title="7. Cookies & Tracking" T={T}>
        <p>CredentialDOMD does not use cookies, analytics, tracking pixels, or any form of user tracking. We do not collect usage statistics or behavioral data. Google Fonts may set cookies per Google's privacy policy.</p>
      </Section>

      <Section title="8. Changes to This Policy" T={T}>
        <p>This privacy policy may be updated as the application evolves. Material changes will be noted in the app's changelog. Continued use of the app after changes constitutes acceptance of the updated policy.</p>
      </Section>

      <Section title="9. Contact" T={T}>
        <p>For privacy-related questions or concerns, contact the app developer at the email listed in the application's distribution page or repository.</p>
      </Section>
    </div>
  );
}

function TermsOfService({ T }) {
  return (
    <div>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 700, color: T.text }}>Terms of Service</h2>
      <p style={{ margin: "0 0 14px", fontSize: 12, color: T.textDim }}>Last updated: February 2026</p>
      <Disclaimer T={T} />

      <Section title="1. Acceptance of Terms" T={T}>
        <p>By using CredentialDOMD, you agree to these Terms of Service. If you do not agree, do not use the application.</p>
      </Section>

      <Section title="2. Description of Service" T={T}>
        <p>CredentialDOMD is a personal credential management tool designed to help physicians organize, track, and share their professional credentials. The app stores data locally on your device and does not require an account or registration.</p>
      </Section>

      <Section title="3. Intended Use" T={T}>
        <p>This application is intended for use by licensed physicians (MD and DO) for personal credential tracking. It is <strong>not</strong> intended as a substitute for:</p>
        <ul style={{ paddingLeft: 18, marginTop: 4 }}>
          <li>Official credentialing verification organizations (NCQA, CAQH, Joint Commission)</li>
          <li>State medical board licensing systems</li>
          <li>Hospital credentialing departments</li>
          <li>Official CME tracking through accrediting bodies</li>
        </ul>
        <p style={{ marginTop: 6 }}>Always verify credential information against official sources before submitting for credentialing applications.</p>
      </Section>

      <Section title="4. Data Accuracy" T={T}>
        <p>You are solely responsible for the accuracy of data entered into CredentialDOMD. The app performs automated compliance calculations based on published state requirements, but these calculations are informational only and may not reflect the most current regulations. Always verify CME requirements with your state medical board.</p>
      </Section>

      <Section title="5. No Warranty" T={T}>
        <p>CredentialDOMD is provided "AS IS" without warranty of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, or non-infringement. We do not warrant that the app will be error-free, uninterrupted, or that defects will be corrected.</p>
      </Section>

      <Section title="6. Limitation of Liability" T={T}>
        <p>In no event shall the developers of CredentialDOMD be liable for any direct, indirect, incidental, special, or consequential damages arising from the use or inability to use this application, including but not limited to:</p>
        <ul style={{ paddingLeft: 18, marginTop: 4 }}>
          <li>Loss of credential data</li>
          <li>Missed renewal deadlines</li>
          <li>Inaccurate compliance calculations</li>
          <li>Credentialing application issues based on app-generated data</li>
        </ul>
      </Section>

      <Section title="7. AI Document Scanning" T={T}>
        <p>The AI document scanning feature uses the Anthropic API with a user-provided API key. You are responsible for your API key and any charges incurred. AI-extracted data should always be reviewed for accuracy before relying on it.</p>
      </Section>

      <Section title="8. Intellectual Property" T={T}>
        <p>CredentialDOMD and its original content, features, and functionality are the property of its developers. The app's brand, logos, and design are protected by applicable intellectual property laws.</p>
      </Section>

      <Section title="9. Modifications" T={T}>
        <p>We reserve the right to modify these terms at any time. Material changes will be communicated through the application. Your continued use after changes constitutes acceptance.</p>
      </Section>

      <Section title="10. Governing Law" T={T}>
        <p>These terms shall be governed by the laws of the jurisdiction in which the app developer resides, without regard to conflict of law provisions.</p>
      </Section>
    </div>
  );
}

function DataRights({ T, showDeleteConfirm, setShowDeleteConfirm, deleteInput, setDeleteInput, handleDeleteAllData }) {
  return (
    <div>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 700, color: T.text }}>Your Data Rights</h2>
      <p style={{ margin: "0 0 14px", fontSize: 13, color: T.textMuted }}>
        Manage, export, or permanently delete all your data.
      </p>

      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: T.shadow1 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 8 }}>Data Portability</h3>
        <p style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.6, marginBottom: 8 }}>
          You can export all your credential data at any time via <strong>More &gt; Data & Backup</strong>.
          The exported JSON file contains all your credentials, CME records, licenses, and settings
          (API keys are excluded for security). This file can be imported back into CredentialDOMD
          or processed by any compatible system.
        </p>
      </div>

      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: T.shadow1 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 8 }}>Data Storage</h3>
        <p style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.6 }}>
          All your data is stored <strong>exclusively on this device</strong> in your browser's localStorage.
          No data is sent to or stored on any external server. Clearing your browser data or
          uninstalling the app will permanently remove all stored information.
        </p>
      </div>

      <div style={{
        backgroundColor: T.card, border: `1px solid ${T.danger}`, borderRadius: 14,
        padding: 18, marginBottom: 14, boxShadow: T.shadow1,
      }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: T.danger, marginBottom: 8 }}>
          Permanently Delete All Data
        </h3>
        <p style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.6, marginBottom: 10 }}>
          This will permanently and irreversibly delete all your credential data, settings,
          documents, CME records, and everything else stored in CredentialDOMD. This cannot be undone.
          We strongly recommend exporting a backup first.
        </p>

        {!showDeleteConfirm ? (
          <button onClick={() => setShowDeleteConfirm(true)} style={{
            padding: "10px 20px", borderRadius: 10, border: `1px solid ${T.danger}`,
            backgroundColor: "transparent", color: T.danger, fontSize: 14, fontWeight: 600,
            cursor: "pointer",
          }}>Delete All My Data</button>
        ) : (
          <div style={{
            padding: "12px 14px", backgroundColor: T.dangerDim, borderRadius: 10,
          }}>
            <p style={{ fontSize: 12, fontWeight: 700, color: T.danger, marginBottom: 8 }}>
              Type DELETE to confirm permanent deletion:
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={deleteInput}
                onChange={e => setDeleteInput(e.target.value)}
                placeholder="Type DELETE"
                style={{
                  flex: 1, padding: "8px 12px", borderRadius: 10,
                  border: `1px solid ${T.danger}`, backgroundColor: T.input,
                  color: T.text, fontSize: 14, fontWeight: 600,
                }}
                autoFocus
              />
              <button onClick={handleDeleteAllData} disabled={deleteInput !== "DELETE"} style={{
                padding: "8px 16px", borderRadius: 10, border: "none",
                backgroundColor: deleteInput === "DELETE" ? T.danger : T.border,
                color: deleteInput === "DELETE" ? "#fff" : T.textDim,
                fontSize: 14, fontWeight: 700, cursor: deleteInput === "DELETE" ? "pointer" : "default",
              }}>Confirm Delete</button>
            </div>
            <button onClick={() => { setShowDeleteConfirm(false); setDeleteInput(""); }} style={{
              marginTop: 8, padding: "6px 0", width: "100%", border: "none",
              backgroundColor: "transparent", color: T.textDim, fontSize: 11, cursor: "pointer",
            }}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(LegalSection);
