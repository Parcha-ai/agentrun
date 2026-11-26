// githubOrgOf: what a person pastes for the App's organization, read as the login the server is sent.
import { describe, expect, it } from "vitest";
import { githubOrgOf } from "./github";

describe("githubOrgOf", () => {
  it("reads a login from its address, its @name, or itself", () => {
    for (const [typed, org] of [["acme", "acme"], [" @acme ", "acme"], ["https://github.com/acme", "acme"], ["github.com/acme/shop", "acme"], ["www.github.com/acme?tab=repositories", "acme"]]) {
      expect(githubOrgOf(typed!), typed).toEqual({ org });
    }
  });

  it("reads an organization's own pages as that organization, never as `orgs` or `organizations`", () => {
    for (const typed of ["https://github.com/orgs/acme", "github.com/orgs/acme/repositories", "https://github.com/organizations/acme/settings", "github.com/organizations/acme/settings/installations#apps"]) {
      expect(githubOrgOf(typed), typed).toEqual({ org: "acme" });
    }
  });

  it("refuses github.com's own pages, which are no organization, and sends nothing", () => {
    for (const typed of ["https://github.com/settings/organizations", "github.com/orgs", "https://github.com/organizations", "github.com/apps/agentrun", "marketplace", "not an org!"]) {
      expect(githubOrgOf(typed).org, typed).toBeUndefined();
      expect(githubOrgOf(typed).problem, typed).toContain("isn't a GitHub organization");
    }
  });

  it("nothing typed is the person's own account", () => expect(githubOrgOf("  ")).toEqual({}));
});
