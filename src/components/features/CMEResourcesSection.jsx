import { useState, useMemo, memo } from "react";
import { useApp } from "../../context/AppContext";
import { SearchIcon, ExternalLinkIcon, GraduationIcon, CheckIcon } from "../shared/Icons";
import { CME_PROVIDERS, getProvidersForTopic, getMateActProviders, getDualAccreditedProviders } from "../../constants/cmeProviders";
import { computeCompliance } from "../../utils/compliance";
import { getProviderVerificationStatus } from "../../utils/cmeVerification";

const PRICING_COLORS = {
  free: { bg: "#dcfce7", color: "#15803d", label: "Free" },
  freemium: { bg: "#dbeafe", color: "#1d4ed8", label: "Freemium" },
  paid: { bg: "#fef3c7", color: "#92400e", label: "Paid" },
  subscription: { bg: "#fce7f3", color: "#9d174d", label: "Subscription" },
  membership: { bg: "#ede9fe", color: "#6d28d9", label: "Membership" },
};

function CMEResourcesSection({ initialTopicFilter }) {
  const { data, theme: T, allTrackedStates } = useApp();
  const deg = data.settings.degreeType;

  const [searchQ, setSearchQ] = useState("");
  const [pricingFilter, setPricingFilter] = useState("all");
  const [topicFilter, setTopicFilter] = useState(initialTopicFilter || null);
  const [viewMode, setViewMode] = useState(initialTopicFilter ? "all" : "forYou");
  const [showMateAct, setShowMateAct] = useState(false);
  const [showStateSpecific, setShowStateSpecific] = useState(false);
  const [showDualAccredited, setShowDualAccredited] = useState(false);

  // Compute user's unmet CME topics
  const unmetTopics = useMemo(() => {
    const topics = new Set();
    allTrackedStates.forEach(st => {
      const comp = computeCompliance(data.cme, st, deg);
      comp.topicResults.filter(t => !t.met).forEach(t => topics.add(t.topic));
    });
    return [...topics];
  }, [allTrackedStates, data.cme, deg]);

  // All unique required topics across user's states
  const allRequiredTopics = useMemo(() => {
    const topics = new Set();
    allTrackedStates.forEach(st => {
      const comp = computeCompliance(data.cme, st, deg);
      comp.topicResults.forEach(t => topics.add(t.topic));
    });
    return [...topics].sort();
  }, [allTrackedStates, data.cme, deg]);

  // Per-state compliance gaps for personalized header
  const perStateGaps = useMemo(() => {
    return allTrackedStates.map(st => {
      const comp = computeCompliance(data.cme, st, deg);
      const unmet = comp.topicResults.filter(t => !t.met);
      const hoursGap = comp.noGeneralReq ? 0 : Math.max(0, comp.totalRequired - comp.totalEarned);
      const cat1Gap = comp.cat1Required > 0 ? Math.max(0, comp.cat1Required - comp.cat1Earned) : 0;
      return { state: st, unmet, hoursGap, cat1Gap, fullyCompliant: comp.fullyCompliant };
    });
  }, [allTrackedStates, data.cme, deg]);

  // Specialty keyword matching for sort boost
  const specialtyProviderIds = useMemo(() => {
    const specs = data.settings.specialties || [];
    if (specs.length === 0) return new Set();
    const ids = new Set();
    specs.forEach(specId => {
      const parts = specId.split(":");
      const specName = parts[parts.length - 1].toLowerCase();
      CME_PROVIDERS.forEach(p => {
        if (p.description.toLowerCase().includes(specName) || p.name.toLowerCase().includes(specName)) {
          ids.add(p.id);
        }
      });
    });
    return ids;
  }, [data.settings.specialties]);

  // Verification results
  const verificationResults = data.settings.cmeVerificationResults || {};
  const lastVerified = data.settings.lastCmeVerification || null;

  // Filter providers
  const filteredProviders = useMemo(() => {
    let providers = [...CME_PROVIDERS];

    // "For You" filter — providers matching unmet topics + degree accreditation
    if (viewMode === "forYou" && unmetTopics.length > 0) {
      providers = providers.filter(p =>
        p.topics.some(t => unmetTopics.includes(t))
      );
      // Degree-appropriate accreditation filter
      providers = providers.filter(p =>
        p.dualAccredited ||
        p.accreditation.some(a =>
          deg === "DO"
            ? a.includes("AOA Category 1") || a.includes("AMA PRA Category 1")
            : a.includes("AMA PRA Category 1")
        )
      );
    }

    // Topic filter
    if (topicFilter) {
      providers = providers.filter(p => p.topics.includes(topicFilter));
    }

    // Pricing filter
    if (pricingFilter === "free") {
      providers = providers.filter(p => p.pricing === "free" || p.pricing === "freemium");
    } else if (pricingFilter !== "all") {
      providers = providers.filter(p => p.pricing === pricingFilter);
    }

    // Special filters
    if (showMateAct) {
      providers = providers.filter(p => p.mateActCompliant);
    }
    if (showStateSpecific) {
      providers = providers.filter(p => p.stateSpecific);
    }
    if (showDualAccredited) {
      providers = providers.filter(p => p.dualAccredited);
    }

    // Search
    if (searchQ.trim()) {
      const q = searchQ.toLowerCase();
      providers = providers.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.topics.some(t => t.toLowerCase().includes(q))
      );
    }

    // Sort: free first, then by topic relevance, then specialty boost
    providers.sort((a, b) => {
      const priceOrder = { free: 0, freemium: 1, paid: 2, subscription: 3, membership: 4 };
      const aDiff = (priceOrder[a.pricing] || 5) - (priceOrder[b.pricing] || 5);
      if (aDiff !== 0) return aDiff;
      const aRel = a.topics.filter(t => unmetTopics.includes(t)).length;
      const bRel = b.topics.filter(t => unmetTopics.includes(t)).length;
      if (bRel !== aRel) return bRel - aRel;
      const aSpec = specialtyProviderIds.has(a.id) ? 0 : 1;
      const bSpec = specialtyProviderIds.has(b.id) ? 0 : 1;
      return aSpec - bSpec;
    });

    return providers;
  }, [viewMode, topicFilter, pricingFilter, searchQ, showMateAct, showStateSpecific, showDualAccredited, unmetTopics, deg, specialtyProviderIds]);

  const isFullyCompliant = unmetTopics.length === 0 && allTrackedStates.length > 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>Find CME Courses</h2>
        <span style={{ fontSize: 13, color: T.textDim }}>{filteredProviders.length} provider{filteredProviders.length !== 1 ? "s" : ""}</span>
      </div>
      <p style={{ margin: "0 0 14px", fontSize: 14, color: T.textMuted, lineHeight: 1.4 }}>
        Browse accredited CME providers to earn credits for your state requirements.
      </p>

      {/* Search */}
      <div style={{ position: "relative", marginBottom: 12 }}>
        <div style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: T.textDim }}><SearchIcon /></div>
        <input
          value={searchQ} onChange={e => setSearchQ(e.target.value)}
          placeholder="Search providers, topics..."
          style={{ width: "100%", padding: "12px 14px 12px 38px", backgroundColor: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 12, color: T.text, fontSize: 15, outline: "none", boxSizing: "border-box" }}
        />
      </div>

      {/* View mode tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {[
          { id: "forYou", label: `For You${unmetTopics.length > 0 ? ` (${unmetTopics.length})` : ""}` },
          { id: "all", label: "All Providers" },
        ].map(m => (
          <button key={m.id} onClick={() => { setViewMode(m.id); setTopicFilter(null); }} style={{
            padding: "8px 16px", fontSize: 13, fontWeight: 600, borderRadius: 22,
            border: `1px solid ${viewMode === m.id ? T.accent : T.border}`,
            backgroundColor: viewMode === m.id ? T.accent : "transparent",
            color: viewMode === m.id ? "#fff" : T.textMuted, cursor: "pointer",
          }}>{m.label}</button>
        ))}
      </div>

      {/* Pricing filter */}
      <div style={{ display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap" }}>
        {[
          { id: "all", label: "All" },
          { id: "free", label: "Free" },
          { id: "paid", label: "Paid" },
          { id: "subscription", label: "Subscription" },
        ].map(p => (
          <button key={p.id} onClick={() => setPricingFilter(p.id)} style={{
            padding: "6px 12px", fontSize: 12, fontWeight: 600, borderRadius: 16,
            border: `1px solid ${pricingFilter === p.id ? T.accent : T.border}`,
            backgroundColor: pricingFilter === p.id ? T.accentGlow : "transparent",
            color: pricingFilter === p.id ? T.accent : T.textDim, cursor: "pointer",
          }}>{p.label}</button>
        ))}
      </div>

      {/* Special filter chips */}
      <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
        <FilterChip label="MATE Act" active={showMateAct} onClick={() => setShowMateAct(!showMateAct)} T={T} />
        <FilterChip label="State-Specific" active={showStateSpecific} onClick={() => setShowStateSpecific(!showStateSpecific)} T={T} />
        {deg === "DO" && <FilterChip label="DO Dual Credit" active={showDualAccredited} onClick={() => setShowDualAccredited(!showDualAccredited)} T={T} />}
      </div>

      {/* Topic filter chips */}
      {(unmetTopics.length > 0 || allRequiredTopics.length > 0) && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.textDim, textTransform: "uppercase", marginBottom: 6, letterSpacing: 0.5 }}>
            {unmetTopics.length > 0 ? "Unmet Topics" : "Required Topics"}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {(unmetTopics.length > 0 ? unmetTopics : allRequiredTopics).map(topic => (
              <button key={topic} onClick={() => setTopicFilter(topicFilter === topic ? null : topic)} style={{
                padding: "6px 12px", fontSize: 12, fontWeight: 600, borderRadius: 14,
                border: topicFilter === topic ? "none" : `1px solid ${unmetTopics.includes(topic) ? T.warning : T.border}`,
                backgroundColor: topicFilter === topic ? T.accent : (unmetTopics.includes(topic) ? T.warningDim : "transparent"),
                color: topicFilter === topic ? "#fff" : (unmetTopics.includes(topic) ? T.warning : T.textMuted),
                cursor: "pointer",
              }}>{topic}</button>
            ))}
          </div>
        </div>
      )}

      {/* Personalized compliance gap summary */}
      {viewMode === "forYou" && !isFullyCompliant && perStateGaps.filter(g => !g.fullyCompliant).length > 0 && (
        <div style={{ backgroundColor: T.warningDim, border: `1px solid ${T.warning}`, borderRadius: 12, padding: "12px 16px", marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 6 }}>
            Gaps in {perStateGaps.filter(g => !g.fullyCompliant).length} state{perStateGaps.filter(g => !g.fullyCompliant).length > 1 ? "s" : ""}
          </div>
          {perStateGaps.filter(g => !g.fullyCompliant).map(g => (
            <div key={g.state} style={{ fontSize: 13, color: T.textMuted, marginBottom: 4, lineHeight: 1.4 }}>
              <span style={{ fontWeight: 700, color: T.text }}>{g.state}:</span>
              {g.hoursGap > 0 && <span> {g.hoursGap} general hrs needed.</span>}
              {g.cat1Gap > 0 && <span> {g.cat1Gap} Cat 1 hrs needed.</span>}
              {g.unmet.length > 0 && (
                <span> Topics: {g.unmet.map(t => `${t.topic} (${(t.required - t.earned).toFixed(1)}h)`).join(", ")}.</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Compliant message */}
      {isFullyCompliant && viewMode === "forYou" && (
        <div style={{ textAlign: "center", padding: "26px 18px", marginBottom: 14, backgroundColor: T.successDim, borderRadius: 14, border: `1px solid ${T.success}` }}>
          <div style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: T.success, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px", color: "#fff" }}><CheckIcon /></div>
          <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 4 }}>Fully Compliant</div>
          <div style={{ fontSize: 14, color: T.textMuted }}>All CME requirements met for your tracked states. Browse providers below to stay ahead.</div>
          <button onClick={() => setViewMode("all")} style={{
            marginTop: 12, padding: "10px 18px", borderRadius: 10, border: "none",
            backgroundColor: T.accent, color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer",
          }}>Browse All Providers</button>
        </div>
      )}

      {/* Last verified indicator */}
      {lastVerified && (
        <div style={{ fontSize: 11, color: T.textDim, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
          Providers last verified: {new Date(lastVerified).toLocaleDateString()}
          <span style={{
            width: 6, height: 6, borderRadius: 3,
            backgroundColor: data.settings.cmeVerificationAlerted ? T.warning : T.success,
          }} />
          <span style={{ fontWeight: 600, color: data.settings.cmeVerificationAlerted ? T.warning : T.success }}>
            {data.settings.cmeVerificationAlerted ? "Some links flagged" : "All reachable"}
          </span>
        </div>
      )}

      {/* Provider list */}
      {filteredProviders.length === 0 ? (
        <div style={{ textAlign: "center", padding: "30px 18px", color: T.textDim, fontSize: 15 }}>
          No providers match your filters. Try adjusting your search or filters.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {viewMode === "forYou" && !isFullyCompliant && (() => {
            const topicMatched = filteredProviders.filter(p => p.topics.some(t => unmetTopics.includes(t)));
            const generalOnly = filteredProviders.filter(p => !p.topics.some(t => unmetTopics.includes(t)));
            return (
              <>
                {topicMatched.length > 0 && (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, padding: "4px 0" }}>Addresses Your Unmet Topics</div>
                    {topicMatched.map(p => <ProviderCard key={p.id} provider={p} T={T} unmetTopics={unmetTopics} verificationResults={verificationResults} />)}
                  </>
                )}
                {generalOnly.length > 0 && (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, padding: "8px 0 4px" }}>General Hours</div>
                    {generalOnly.map(p => <ProviderCard key={p.id} provider={p} T={T} unmetTopics={unmetTopics} verificationResults={verificationResults} />)}
                  </>
                )}
              </>
            );
          })()}
          {(viewMode !== "forYou" || isFullyCompliant) && filteredProviders.map(provider => (
            <ProviderCard key={provider.id} provider={provider} T={T} unmetTopics={unmetTopics} verificationResults={verificationResults} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({ label, active, onClick, T }) {
  return (
    <button onClick={onClick} style={{
      padding: "6px 12px", fontSize: 12, fontWeight: 600, borderRadius: 16,
      border: `1px solid ${active ? T.accent : T.border}`,
      backgroundColor: active ? T.accentGlow : "transparent",
      color: active ? T.accent : T.textDim, cursor: "pointer",
    }}>{label}</button>
  );
}

const VERIFY_COLORS = { ok: "#22c55e", timeout: "#eab308", unreachable: "#eab308", unchecked: "#9ca3af" };

const ProviderCard = memo(function ProviderCard({ provider, T, unmetTopics, verificationResults }) {
  const [expanded, setExpanded] = useState(false);
  const pricing = PRICING_COLORS[provider.pricing] || PRICING_COLORS.paid;
  const matchingUnmet = provider.topics.filter(t => unmetTopics.includes(t));
  const vStatus = verificationResults ? getProviderVerificationStatus(verificationResults, provider.id) : "unchecked";

  return (
    <div style={{
      backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14,
      padding: "16px 18px", borderLeft: matchingUnmet.length > 0 ? `3px solid ${T.accent}` : undefined,
      boxShadow: T.shadow1,
    }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{provider.name}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
            <span style={{ padding: "2px 8px", fontSize: 11, fontWeight: 700, borderRadius: 10, backgroundColor: pricing.bg, color: pricing.color }}>{pricing.label}</span>
            {provider.mateActCompliant && <span style={{ padding: "2px 8px", fontSize: 11, fontWeight: 700, borderRadius: 10, backgroundColor: T.successDim, color: T.success }}>MATE Act</span>}
            {provider.dualAccredited && <span style={{ padding: "2px 8px", fontSize: 11, fontWeight: 700, borderRadius: 10, backgroundColor: "#ede9fe", color: "#7c3aed" }}>Dual AMA/AOA</span>}
            {provider.stateSpecific && <span style={{ padding: "2px 8px", fontSize: 11, fontWeight: 700, borderRadius: 10, backgroundColor: T.warningDim, color: T.warning }}>State-Specific</span>}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <span title={vStatus === "ok" ? "Verified reachable" : vStatus === "unchecked" ? "Not yet verified" : "Link may be down"}
            style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: VERIFY_COLORS[vStatus] || VERIFY_COLORS.unchecked }} />
          <a href={provider.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{
            padding: "8px 14px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff",
            fontSize: 13, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4,
            textDecoration: "none",
          }}>Visit <ExternalLinkIcon /></a>
        </div>
      </div>

      {/* Description */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.4, marginBottom: 10, cursor: "pointer" }}
      >
        {expanded ? provider.description : (provider.description.length > 120 ? provider.description.slice(0, 120) + "..." : provider.description)}
        {provider.description.length > 120 && (
          <span style={{ color: T.accent, fontWeight: 600, marginLeft: 4 }}>{expanded ? "less" : "more"}</span>
        )}
      </div>

      {/* Pricing note */}
      {provider.pricingNote && (
        <div style={{ fontSize: 12, color: T.textDim, marginBottom: 8 }}>{provider.pricingNote}</div>
      )}

      {/* Matching unmet topics */}
      {matchingUnmet.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
          {matchingUnmet.map(t => (
            <span key={t} style={{ padding: "2px 8px", fontSize: 11, fontWeight: 600, borderRadius: 10, backgroundColor: T.accentGlow, color: T.accent, border: `1px solid ${T.accent}` }}>{t}</span>
          ))}
        </div>
      )}

      {/* Accreditation + Format (collapsed info) */}
      {expanded && (
        <div style={{ marginTop: 8, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 12, color: T.textDim, marginBottom: 4 }}>
            <strong>Accreditation:</strong> {provider.accreditation.join(", ")}
          </div>
          <div style={{ fontSize: 12, color: T.textDim, marginBottom: 4 }}>
            <strong>Format:</strong> {provider.format.join(", ")}
          </div>
          {provider.stateSpecificNote && (
            <div style={{ fontSize: 12, color: T.warning, marginBottom: 4 }}>{provider.stateSpecificNote}</div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {provider.topics.map(t => (
              <span key={t} style={{
                padding: "2px 8px", fontSize: 11, fontWeight: 500, borderRadius: 8,
                backgroundColor: unmetTopics.includes(t) ? T.accentGlow : T.input,
                color: unmetTopics.includes(t) ? T.accent : T.textDim,
              }}>{t}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export default memo(CMEResourcesSection);
