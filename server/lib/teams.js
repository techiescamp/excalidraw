import { fail, transaction, uuid } from "./core.js";
export const collectionTeamVisibility = `(NOT c.team_restricted OR $2::boolean OR EXISTS(
 SELECT 1 FROM workspace_team_collections tc JOIN workspace_team_members tm ON tm.team_id=tc.team_id
 WHERE tc.collection_id=c.id AND tm.user_id=$1))`;
export function installTeams(app, db, { auth, admin, recent }) {
  const name = (value) => {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      [...value.trim()].length > 80
    )
      fail(400, "Use a team name of 1–80 characters.");
    return value.trim();
  };
  const ids = (value) => {
    if (
      !Array.isArray(value) ||
      value.length > 1000 ||
      value.some((v) => !uuid(v))
    )
      fail(400, "Invalid selection.");
    return [...new Set(value)];
  };
  const notify = async (tx, workspace) => {
    await tx.query(
      "SELECT pg_notify('auth_changed',user_id::text) FROM workspace_members WHERE workspace_id=$1",
      [workspace],
    );
  };
  app.get("/api/admin/workspaces/:id/teams", auth, admin, async (req, res) => {
    const workspace = req.params.id;
    const [teams, members, collections] = await Promise.all([
      db.query(
        `SELECT t.*,coalesce((SELECT jsonb_agg(m.user_id) FROM workspace_team_members m WHERE m.team_id=t.id),'[]') AS members FROM workspace_teams t WHERE workspace_id=$1 ORDER BY lower(name)`,
        [workspace],
      ),
      db.query(
        "SELECT u.id,u.username,u.display_name,m.role FROM workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND u.is_active ORDER BY u.username",
        [workspace],
      ),
      db.query(
        `SELECT c.id,c.name,c.version,c.team_restricted,coalesce((SELECT jsonb_agg(tc.team_id) FROM workspace_team_collections tc WHERE tc.collection_id=c.id),'[]') AS teams FROM collections c WHERE c.workspace_id=$1 AND c.deleted_at IS NULL AND NOT c.is_private ORDER BY lower(c.name)`,
        [workspace],
      ),
    ]);
    res.json({
      teams: teams.rows,
      members: members.rows,
      collections: collections.rows,
    });
  });
  const saveTeam = async (req, res) => {
    const workspace = req.params.id,
      teamId = req.params.team,
      nameValue = name(req.body?.name),
      members = ids(req.body?.members);
    if (!/^#[0-9a-f]{6}$/i.test(req.body?.color || ""))
      fail(400, "Choose a valid team color.");
    const result = await transaction(db, async (tx) => {
      if (
        !(await tx.query("SELECT 1 FROM workspaces WHERE id=$1", [workspace]))
          .rowCount
      )
        fail(404, "Workspace not found.");
      let team;
      if (teamId) {
        const { rows } = await tx.query(
          "UPDATE workspace_teams SET name=$3,color=$4,version=version+1 WHERE workspace_id=$1 AND id=$2 AND version=$5 RETURNING *",
          [workspace, teamId, nameValue, req.body.color, req.body.version],
        );
        team = rows[0];
        if (!team) fail(409, "Team changed. Refresh before editing.");
      } else
        team = (
          await tx.query(
            "INSERT INTO workspace_teams(workspace_id,name,color) VALUES($1,$2,$3) RETURNING *",
            [workspace, nameValue, req.body.color],
          )
        ).rows[0];
      await tx.query("DELETE FROM workspace_team_members WHERE team_id=$1", [
        team.id,
      ]);
      for (const user of members)
        await tx.query(
          "INSERT INTO workspace_team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
          [workspace, team.id, user],
        );
      await tx.query(
        "INSERT INTO audit_log(actor_id,action,target_type,target_id,metadata) VALUES($1,'team.save','team',$2,$3)",
        [req.user.id, team.id, { outcome: "success" }],
      );
      await notify(tx, workspace);
      return team;
    });
    res.status(teamId ? 200 : 201).json(result);
  };
  app.post("/api/admin/workspaces/:id/teams", auth, admin, recent, saveTeam);
  app.patch(
    "/api/admin/workspaces/:id/teams/:team",
    auth,
    admin,
    recent,
    saveTeam,
  );
  app.put(
    "/api/admin/collections/:id/access",
    auth,
    admin,
    recent,
    async (req, res) => {
      const teams = ids(req.body?.teams),
        restricted = req.body?.restricted;
      if (typeof restricted !== "boolean" || (restricted && !teams.length))
        fail(400, "Select at least one team, or allow all workspace members.");
      await transaction(db, async (tx) => {
        const { rows } = await tx.query(
          "SELECT * FROM collections WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
          [req.params.id],
        );
        const col = rows[0];
        if (!col) fail(404, "Collection not found.");
        if (col.version !== req.body.version)
          fail(409, "Collection changed. Refresh before changing access.");
        await tx.query(
          "DELETE FROM workspace_team_collections WHERE collection_id=$1",
          [col.id],
        );
        for (const team of teams)
          await tx.query(
            "INSERT INTO workspace_team_collections(workspace_id,team_id,collection_id) VALUES($1,$2,$3)",
            [col.workspace_id, team, col.id],
          );
        await tx.query(
          "UPDATE collections SET team_restricted=$2,version=version+1 WHERE id=$1",
          [col.id, restricted],
        );
        await tx.query(
          "INSERT INTO audit_log(actor_id,action,target_type,target_id,metadata) VALUES($1,'collection.access','collection',$2,$3)",
          [req.user.id, col.id, { outcome: "success", restricted }],
        );
        await notify(tx, col.workspace_id);
      });
      res.json({ ok: true });
    },
  );
}
