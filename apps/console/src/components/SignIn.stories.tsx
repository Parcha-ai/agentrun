import type { Meta, StoryObj } from "@storybook/react-vite";
import { SignIn } from "@/components/SignIn";
import { recorded } from "@/fixtures";
import { signInProblem } from "@/lib/auth";
import { ClientError } from "@/lib/client";

// The sign-in card in each mode the server's session names (src/fixtures/auth.*), and its refusals as the server sent them.
const meta: Meta = { title: "Sign in" };
export default meta;
type Story = StoryObj;
const refusal = (name: string) => {
  const r = recorded<{ error: { code: string; message: string; fields?: { field: string; reason: string; message: string }[] } }>(name);
  return signInProblem(Object.assign(new ClientError(r.status, r.body.error.code, r.body.error.message), { fields: r.body.error.fields }));
};
export const SignInCard: Story = { render: () => <SignIn mode="sign_in" onSubmit={async () => null} /> };
export const WrongPassword: Story = { render: () => <SignIn mode="sign_in" problem={refusal("auth.sign-in-wrong")} onSubmit={async () => null} /> };
export const FirstVisit: Story = { render: () => <SignIn mode="setup" onSubmit={async () => null} /> };
export const FirstVisitOnThisMachine: Story = { render: () => <SignIn mode="setup" offer={{ projects: 3, sessions: 41, candidates: [
  { id: "imp-1", name: "acme-site", path: "/work/acme-site", sessions: 28, sources: ["claude-code", "codex"], last_active: new Date(Date.now() - 3 * 3600_000).toISOString() },
  { id: "imp-2", name: "billing-api", path: "/work/billing-api", sessions: 12, sources: ["claude-code"], last_active: new Date(Date.now() - 4 * 86_400_000).toISOString() },
  { id: "imp-3", name: "field-notes", path: "/work/field-notes", sessions: 1, sources: ["pi"], last_active: new Date(Date.now() - 90 * 86_400_000).toISOString() },
] }} onSubmit={async () => null} /> };
export const FirstVisitCounting: Story = { render: () => <SignIn mode="setup" offer={{ counting: true }} onSubmit={async () => null} /> };
export const FirstVisitWithCode: Story = { render: () => <SignIn mode="setup" code="" onSubmit={async () => null} /> };
export const PasswordTooShort: Story = { render: () => <SignIn mode="setup" problem={refusal("auth.setup-short")} onSubmit={async () => null} /> };
export const OwnerAlreadySet: Story = { render: () => <SignIn mode="setup" problem={refusal("auth.setup-again")} onSubmit={async () => null} /> };
export const NoAccounts: Story = { render: () => <SignIn mode="token_link" /> };
export const Phone: Story = { render: () => <SignIn mode="sign_in" onSubmit={async () => null} />, globals: { viewport: { value: "mobile1" } } };
