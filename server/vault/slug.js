// A note name with case, accents, ".md" and the space, hyphen or underscore between words
// ignored: "Agents/Head of Internal Comms.md" and "agents/head-of-internal-comms" are the same.
export function noteSlug(value) {
  return String(value ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\.md$/, "").replace(/[\s_-]+/g, "-");
}
