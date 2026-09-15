import { protectSecret, revealSecret } from "./secrets.js";
import { Server } from "socket.io";
import { fail, transaction } from "./core.js";
import crypto from "node:crypto";

export async function installCollaboration(
  app,
  httpServer,
  db,
  storage,
  security,
  drawings,
  origin,
) {
  const { auth, sessionUser } = security;
  const roomAccess = async (user, id, write = false) => {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{10,100}$/.test(id))
      fail(404, "Room not found.");
    const { rows } = await db.query("SELECT id FROM scenes WHERE room_id=$1", [
      id,
    ]);
    if (!rows[0]) fail(404, "Room not found.");
    return drawings.sceneAccess(
      user,
      rows[0].id,
      write ? "drawing.edit" : "drawing.read",
    );
  };
  app.post("/api/scenes/:id/room", auth, async (req, res) => {
    const room = req.body?.room_id;
    if (typeof room !== "string" || !/^[a-zA-Z0-9_-]{10,100}$/.test(room))
      fail(400, "Invalid room ID.");
    const roomKey = req.body?.room_key;
    if (
      roomKey !== undefined &&
      // 128-bit key encoded as base64url: exactly what the editor can import
      (typeof roomKey !== "string" || !/^[a-zA-Z0-9_-]{22}$/.test(roomKey))
    )
      fail(400, "Invalid room key.");
    const result = await transaction(db, async (tx) => {
      await tx.query("SELECT id FROM scenes WHERE id=$1 FOR UPDATE", [
        req.params.id,
      ]);
      const { scene } = await drawings.sceneAccess(
        req.user,
        req.params.id,
        "drawing.edit",
        tx,
      );
      const stored = (
        await tx.query(
          "SELECT * FROM scene_room_keys WHERE scene_id=$1 AND room_id=$2",
          [scene.id, scene.room_id],
        )
      ).rows[0];
      if (stored)
        return {
          roomId: stored.room_id,
          roomKey: revealSecret(stored.encrypted_key),
        };
      if (scene.room_id && scene.room_id !== room)
        fail(
          409,
          "This drawing has a legacy room. Open its existing private collaboration link.",
        );
      await tx.query("UPDATE scenes SET room_id=$2 WHERE id=$1", [
        scene.id,
        room,
      ]);
      if (roomKey)
        await tx.query(
          "INSERT INTO scene_room_keys(scene_id,room_id,encrypted_key) VALUES($1,$2,$3) ON CONFLICT(scene_id) DO UPDATE SET room_id=$2,encrypted_key=$3",
          [scene.id, room, protectSecret(roomKey)],
        );
      return { roomId: room, roomKey };
    });
    res.json(result);
  });
  app.get("/api/rooms/:roomId/scene", auth, async (req, res) => {
    const { scene } = await roomAccess(req.user, req.params.roomId);
    // Existing encrypted room payloads keep their original storage keys.
    const key = scene.collab_s3_key || `rooms/${req.params.roomId}/scene.bin`;
    if (!(await storage.pipe(key, res))) res.sendStatus(404);
  });
  app.put("/api/rooms/:roomId/scene", auth, async (req, res) => {
    const { scene } = await roomAccess(req.user, req.params.roomId, true);
    if (!Buffer.isBuffer(req.body))
      fail(400, "Expected encrypted scene bytes.");
    const key = `rooms/${req.params.roomId}/${crypto.randomUUID()}.bin`;
    await storage.put(key, req.body);
    await db.query("UPDATE scenes SET collab_s3_key=$2 WHERE id=$1", [
      scene.id,
      key,
    ]);
    res.json({ ok: true });
  });
  const assetAccess = async (req, write = false) => {
    const { scope, id, fileId } = req.params;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(fileId)) fail(400, "Invalid file ID.");
    if (scope === "rooms") return roomAccess(req.user, id, write);
    if (scope === "scenes")
      return drawings.sceneAccess(
        req.user,
        id,
        write ? "drawing.edit" : "drawing.read",
      );
    fail(404, "Asset not found.");
  };
  app.post("/api/files/upload-url", auth, async (req, res) => {
    const match = /^\/?files\/(scenes|rooms)\/([a-zA-Z0-9_-]+)$/.exec(
      req.body?.prefix || "",
    );
    if (!match) fail(400, "Invalid asset scope.");
    req.params = { scope: match[1], id: match[2], fileId: req.body.file_id };
    await assetAccess(req, true);
    res.json({
      url: `${origin}/api/files/${match[1]}/${match[2]}/${req.body.file_id}`,
    });
  });
  app.put("/api/files/:scope/:id/:fileId", auth, async (req, res) => {
    const { scene } = await assetAccess(req, true);
    if (!Buffer.isBuffer(req.body)) fail(400, "Expected asset bytes.");
    const key = `files/${req.params.scope}/${req.params.id}/${
      req.params.fileId
    }/${crypto.randomUUID()}`;
    await storage.put(key, req.body);
    await db.query(
      "INSERT INTO scene_files(file_id,scene_id,room_id,s3_key,size_bytes) VALUES($1,$2,$3,$4,$5)",
      [
        req.params.fileId,
        scene.id,
        req.params.scope === "rooms" ? req.params.id : null,
        key,
        req.body.length,
      ],
    );
    res.json({ ok: true });
  });
  app.get("/api/files/:scope/:id/:fileId", auth, async (req, res) => {
    const { scene } = await assetAccess(req);
    const { rows } = await db.query(
      "SELECT s3_key FROM scene_files WHERE file_id=$1 AND scene_id=$2 ORDER BY created_at DESC LIMIT 1",
      [req.params.fileId, scene.id],
    );
    const key =
      rows[0]?.s3_key ||
      `files/${req.params.scope}/${req.params.id}/${req.params.fileId}`;
    if (!(await storage.pipe(key, res))) res.sendStatus(404);
  });
  const io = new Server(httpServer, {
    cors: { origin, credentials: true },
    maxHttpBufferSize: 25 * 1024 * 1024,
    allowRequest: (req, callback) =>
      callback(null, req.headers.origin === origin),
  });
  const tokenOf = (socket) =>
    String(socket.request.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("ex_session="))
      ?.slice(11);
  const check = async (socket, write = false) => {
    const user = await sessionUser(tokenOf(socket));
    if (!user) throw new Error("unauthenticated");
    if (socket.data.room) await roomAccess(user, socket.data.room, write);
    socket.data.user = user;
    return user;
  };
  io.use((socket, next) =>
    check(socket)
      .then(() => next())
      .catch(() => next(new Error("unauthenticated"))),
  );
  const users = (room) => [...(io.sockets.adapter.rooms.get(room) || [])];
  io.on("connection", (socket) => {
    socket.emit("init-room");
    socket.on("join-room", async (room) => {
      try {
        const user = await check(socket);
        await roomAccess(user, room);
        if (socket.data.room && socket.data.room !== room)
          throw new Error("Cannot switch rooms.");
        socket.data.room = room;
        await socket.join(room);
        if (users(room).length === 1) socket.emit("first-in-room");
        else socket.to(room).emit("new-user", socket.id);
        io.to(room).emit("room-user-change", users(room));
      } catch {
        socket.disconnect(true);
      }
    });
    for (const event of ["server-broadcast", "server-volatile-broadcast"])
      socket.on(event, async (room, bytes, iv) => {
        try {
          await check(socket, true);
          if (
            room !== socket.data.room ||
            !Buffer.isBuffer(bytes) ||
            bytes.length > 25 * 1024 * 1024
          )
            throw new Error("Invalid message.");
          // Recheck each receiver as well, so stale permissions never authorize delivery.
          for (const id of users(room)) {
            if (id === socket.id) continue;
            const target = io.sockets.sockets.get(id);
            if (!target) continue;
            try {
              await check(target);
              target.emit("client-broadcast", bytes, iv);
            } catch {
              target.disconnect(true);
            }
          }
        } catch {
          socket.disconnect(true);
        }
      });
    socket.on("disconnect", () => {
      if (socket.data.room)
        io.to(socket.data.room).emit(
          "room-user-change",
          users(socket.data.room),
        );
    });
  });
  // LISTEN is per server instance; revocations fan out across every deployed API/relay.
  const listener = await db.connect();
  await listener.query("LISTEN auth_changed");
  await listener.query("LISTEN workspace_changed");
  listener.on("notification", (event) => {
    for (const socket of io.sockets.sockets.values()) {
      if (event.channel === "workspace_changed")
        check(socket).catch(() => socket.disconnect(true));
      else if (socket.data.user?.id === event.payload) socket.disconnect(true);
    }
  });
  listener.on("error", () => {
    for (const socket of io.sockets.sockets.values()) socket.disconnect(true);
  });
  const timer = setInterval(() => {
    for (const socket of io.sockets.sockets.values())
      check(socket).catch(() => socket.disconnect(true));
  }, 30000);
  timer.unref();
  httpServer.on("close", () => {
    clearInterval(timer);
    listener.release();
  });
  return io;
}
