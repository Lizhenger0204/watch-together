import { AppError } from "../errors";

export function readOffer(sdp: string) {
  const [session = "", ...media] = sdp.trimEnd().split(/\r?\nm=/);
  if (
    !/^v=0\r?\n/.test(session) ||
    !/^o=\S+ \d+ \d+ IN IP[46] \S+\r?$/m.test(session) ||
    !/^s=.+\r?$/m.test(session) ||
    !/^t=\d+ \d+\r?$/m.test(session) ||
    sdp.includes("\0") ||
    /\r(?!\n)/.test(sdp)
  ) {
    throw new AppError("BAD_REQUEST");
  }

  const mids = new Set<string>();
  const sections = media.map((section) => {
    const [description = "", ...attributes] = section.split(/\r?\n/);
    const entry = /^(audio|video) (\d+) \S+ .+$/.exec(description);
    const identifiers = attributes.filter((line) => line.startsWith("a=mid:"));
    const mid = /^a=mid:([\w-]+)$/.exec(identifiers[0] ?? "")?.[1];
    if (!entry || !mid || identifiers.length !== 1 || mids.has(mid)) {
      throw new AppError("BAD_REQUEST");
    }
    mids.add(mid);
    const direction =
      attributes.find((line) =>
        /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line),
      ) ??
      /^a=(sendrecv|sendonly|recvonly|inactive)\r?$/m
        .exec(session)?.[0]
        .trimEnd() ??
      "a=sendrecv";
    return { mid, active: Number(entry[2]) !== 0, direction };
  });
  if (!sections.length) throw new AppError("BAD_REQUEST");
  return sections;
}
