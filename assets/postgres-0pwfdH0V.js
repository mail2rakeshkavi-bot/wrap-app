const BASE = "http://localhost:3001/api";
class PostgresAdapter {
  async req(method, path, body) {
    const res = await fetch(`${BASE}/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body !== void 0 ? JSON.stringify(body) : void 0
    });
    if (res.status === 204) return void 0;
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `API error ${res.status}`);
    return json;
  }
  async getAll(table) {
    try {
      return await this.req("GET", table);
    } catch (e) {
      console.error(`[PG] getAll ${table}:`, e);
      return [];
    }
  }
  async getById(table, id) {
    try {
      return await this.req("GET", `${table}/${id}`);
    } catch {
      return null;
    }
  }
  async create(table, data) {
    return this.req("POST", table, data);
  }
  async update(table, id, data) {
    await this.req("PATCH", `${table}/${id}`, data);
  }
  async remove(table, id) {
    await this.req("DELETE", `${table}/${id}`);
  }
  async query(table, filters) {
    const all = await this.getAll(table);
    return all.filter(
      (r) => Object.entries(filters).every(([k, v]) => r[k] === v)
    );
  }
}
export {
  PostgresAdapter
};
