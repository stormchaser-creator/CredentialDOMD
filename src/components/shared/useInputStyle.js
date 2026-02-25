import { useMemo } from "react";
import { useApp } from "../../context/AppContext";

export function useInputStyle() {
  const { theme: T } = useApp();
  return useMemo(() => ({
    width: "100%",
    padding: "12px 16px",
    backgroundColor: T.input,
    border: `1px solid ${T.inputBorder}`,
    borderRadius: 10,
    color: T.text,
    fontSize: 15,
    outline: "none",
    boxSizing: "border-box",
    transition: "border-color 0.2s ease",
  }), [T.input, T.inputBorder, T.text]);
}
