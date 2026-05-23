export async function loadPrinted() {
    const res = await fetch("/api/printed");
    const data = await res.json();
    return data.ids || [];
}
export async function savePrinted(ids) {
    await fetch("/api/printed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
    });
}
export async function removePrinted(id) {
    await fetch(`/api/printed/${id}`, { method: "DELETE" });
}
