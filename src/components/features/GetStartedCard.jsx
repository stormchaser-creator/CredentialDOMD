import { AsclepiusIcon } from "../shared/Icons";
import ProfessionPicker from "./ProfessionPicker";

// Home's empty state. A member who has chosen a profession adds a licence of
// that profession in one tap. A member whose profession is still blank is
// asked it first, on the same card: the licence types, rules and renewal
// links all follow the profession, and a PA or NP licence filed under the
// physician list would be tracked on physician rules until it is fixed.
export default function GetStartedCard({ degreeType, onAdd, onChooseProfession, theme: T }) {
  const icon = (
    <div style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: T.accentDim, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
      <AsclepiusIcon size={26} color={T.accent} />
    </div>
  );
  if (!degreeType) {
    return (
      <div style={{
        backgroundColor: T.card, borderRadius: 16, padding: "28px 20px",
        marginBottom: 16, border: `2px dashed ${T.border}`,
        textAlign: "center", boxShadow: T.shadow1,
      }}>
        {icon}
        <div style={{ fontSize: 17, fontWeight: 700, color: T.text, marginBottom: 4 }}>Get Started</div>
        <ProfessionPicker
          id="get-started-profession"
          why="Your profession sets the license types and the rules the app tracks."
          onChoose={onChooseProfession}
          theme={T}
        />
      </div>
    );
  }
  return (
    <div onClick={onAdd} style={{
      backgroundColor: T.card, borderRadius: 16, padding: "32px 24px",
      marginBottom: 16, cursor: "pointer", border: `2px dashed ${T.border}`,
      textAlign: "center", boxShadow: T.shadow1,
    }}>
      {icon}
      <div style={{ fontSize: 17, fontWeight: 700, color: T.text, marginBottom: 4 }}>Get Started</div>
      <div style={{ fontSize: 14, color: T.textMuted }}>{degreeType === "PA" ? "Add your physician assistant license to begin tracking credentials" : degreeType === "NP" ? "Add your APRN and RN licenses to begin tracking credentials" : "Add your medical license to begin tracking credentials"}</div>
    </div>
  );
}
