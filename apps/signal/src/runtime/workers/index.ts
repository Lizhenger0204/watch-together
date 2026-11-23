import { DurableObject } from "cloudflare:workers";
import app from "../../app";

export class RoomDO extends DurableObject {}
export class InviteDirectoryDO extends DurableObject {}

export default app;
