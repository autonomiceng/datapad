import type { CustomerProfile } from "../../customers/contract";

// Mirrors the reviewed synthetic portal fixture. The server rejects anything else.
const sampleIdentities = [
  {
    email: "staff@example.test",
    access:
      "Staff. Sees both sample customers, edits profiles and invites members.",
  },
  {
    email: "elm-admin@example.test",
    access: "Administrator of Elm Studio (sample). Manages its members.",
  },
  {
    email: "collaborator@example.test",
    access: "Member of both sample customers.",
  },
  {
    email: "outsider@example.test",
    access: "Signs in without access to any customer.",
  },
];
const sampleProfiles = [
  {
    names: ["Elm Studio (sample)", "Elm Studio Updated (sample)"],
    billingEmail: "billing-elm@example.test",
  },
  {
    names: ["Birch Works (sample)", "Birch Works Updated (sample)"],
    billingEmail: "billing-birch@example.test",
  },
];

export function SampleAccounts() {
  return (
    <section className="panel account-section account-sample">
      <h2>Sample accounts</h2>
      <p>
        Sign-in links for this sample portal arrive in a local test inbox.{" "}
        <a href="/sample-inbox" target="_blank" rel="noreferrer">
          Open test inbox
        </a>
      </p>
      <dl className="account-identities">
        {sampleIdentities.map((identity) => (
          <div key={identity.email}>
            <dt>{identity.email}</dt>
            <dd>{identity.access}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function SampleProfileNote({ profile }: { profile: CustomerProfile }) {
  const sample = sampleProfiles.find((candidate) =>
    candidate.names.includes(profile.legalName),
  );
  if (!sample) return null;
  return (
    <p className="account-note">
      This sample portal saves only reviewed values. Display name and legal name
      can each be {sample.names.join(" or ")}. Billing email can be{" "}
      {sample.billingEmail} or blank.
    </p>
  );
}
