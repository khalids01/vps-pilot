import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckRow } from "./quick-setup-controls";
import {
  parseQuickSetupCustomRule,
  type QuickSetupDraft,
  type QuickSetupRuleProtocol,
  quickSetupFirewallRuleKey,
  quickSetupFirewallRuleLimit,
  quickSetupRuleProtocols,
  resolveQuickSetupFirewallPlan,
} from "./quick-setup-model";

export function QuickSetupFirewallControls({
  draft,
  currentPort,
  idPrefix,
  onChange,
}: {
  draft: QuickSetupDraft;
  currentPort: number;
  idPrefix: string;
  onChange: (access: QuickSetupDraft["access"]) => void;
}) {
  const [portText, setPortText] = useState("");
  const [protocol, setProtocol] = useState<QuickSetupRuleProtocol>("tcp");
  const [ruleError, setRuleError] = useState("");
  const plan = resolveQuickSetupFirewallPlan(draft, currentPort);
  const rulesAtLimit = draft.access.rules.length >= quickSetupFirewallRuleLimit;

  function addRule() {
    const parsed = parseQuickSetupCustomRule(
      portText,
      protocol,
      draft.access.rules,
    );
    if ("error" in parsed) {
      setRuleError(parsed.error);
      return;
    }
    setRuleError("");
    setPortText("");
    onChange({
      ...draft.access,
      rules: [...draft.access.rules, parsed.rule],
    });
  }
  function removeRule(port: number, ruleProtocol: QuickSetupRuleProtocol) {
    setRuleError("");
    onChange({
      ...draft.access,
      rules: draft.access.rules.filter(
        (rule) => !(rule.port === port && rule.protocol === ruleProtocol),
      ),
    });
  }

  return (
    <div className="space-y-5">
      <section
        aria-labelledby={`${idPrefix}-firewall-plan`}
        className="space-y-2"
      >
        <h3 id={`${idPrefix}-firewall-plan`} className="text-sm font-medium">
          Planned inbound rules
        </h3>
        {plan.apply ? (
          <>
            <table className="w-full border-y border-border/70 text-sm">
              <caption className="sr-only">
                Planned firewall allow rules. These rules are not observed or
                applied.
              </caption>
              <thead>
                <tr className="border-b border-border/70 text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Port
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Protocol
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Purpose
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Source
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {plan.rules.map((rule) => (
                  <tr key={quickSetupFirewallRuleKey(rule)}>
                    <td className="py-2 pr-3 tabular-nums">{rule.port}</td>
                    <td className="py-2 pr-3 uppercase">{rule.protocol}</td>
                    <td className="py-2">
                      {rule.purpose}
                      {rule.protected && (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          Protected
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">
                      Any IPv4/IPv6
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Planned default policy: inbound deny, outbound allow. Protected
              SSH rules cannot be removed here.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No planned rule changes. Current firewall choices are retained.
          </p>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          This is a plan only. Live UFW rules, provider firewalls and IPv4/IPv6
          reachability are not observed or applied here. Use Open server
          inspection to view current rules explicitly.
        </p>
      </section>

      <div className="divide-y divide-border/70 border-y border-border/70">
        <CheckRow
          id={`${idPrefix}-allow-http`}
          label="Allow HTTP (port 80)"
          hint="Typical web ingress. Only planned when the firewall is configured."
          checked={draft.access.allowHttp}
          onToggle={() =>
            onChange({
              ...draft.access,
              allowHttp: !draft.access.allowHttp,
            })
          }
        />
        <CheckRow
          id={`${idPrefix}-allow-https`}
          label="Allow HTTPS (port 443)"
          hint="Typical secure web ingress. Only planned when the firewall is configured."
          checked={draft.access.allowHttps}
          onToggle={() =>
            onChange({
              ...draft.access,
              allowHttps: !draft.access.allowHttps,
            })
          }
        />
      </div>

      <section
        aria-labelledby={`${idPrefix}-custom-rules`}
        className="space-y-2"
      >
        <h3 id={`${idPrefix}-custom-rules`} className="text-sm font-medium">
          Additional TCP or UDP rules
        </h3>
        {draft.access.rules.length > 0 && (
          <ul
            aria-label="Custom firewall rules"
            className="divide-y divide-border/70 border-y border-border/70"
          >
            {draft.access.rules.map((rule) => (
              <li
                key={quickSetupFirewallRuleKey(rule)}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span className="text-sm tabular-nums">
                  {rule.port}/{rule.protocol}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${rule.port}/${rule.protocol} custom rule`}
                  onClick={() => removeRule(rule.port, rule.protocol)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-28 space-y-1.5">
            <label
              htmlFor={`${idPrefix}-custom-port`}
              className="block text-xs text-muted-foreground"
            >
              Port
            </label>
            <Input
              id={`${idPrefix}-custom-port`}
              inputMode="numeric"
              value={portText}
              maxLength={5}
              autoComplete="off"
              aria-invalid={Boolean(ruleError)}
              aria-describedby={
                ruleError ? `${idPrefix}-custom-port-error` : undefined
              }
              onChange={(event) => setPortText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addRule();
                }
              }}
            />
          </div>
          <fieldset aria-label="Custom rule protocol" className="min-w-0">
            <legend className="mb-1.5 block text-xs text-muted-foreground">
              Protocol
            </legend>
            <div className="flex gap-1">
              {quickSetupRuleProtocols.map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={protocol === value}
                  onClick={() => setProtocol(value)}
                  className="rounded-none border border-border/70 uppercase aria-pressed:border-primary aria-pressed:text-foreground"
                >
                  {value}
                </Button>
              ))}
            </div>
          </fieldset>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={rulesAtLimit}
            onClick={addRule}
          >
            Add rule
          </Button>
        </div>
        {ruleError && (
          <p
            id={`${idPrefix}-custom-port-error`}
            role="alert"
            className="text-xs text-destructive"
          >
            {ruleError}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Up to {quickSetupFirewallRuleLimit} custom rules. Source restrictions
          are not planned; all sources are Any IPv4/IPv6.
        </p>
      </section>

      {draft.stack.choice === "dokploy" && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Dokploy typically needs ingress on ports 80 and 443. Its dashboard on
          port 3000 is not exposed automatically. Docker-published ports bypass
          assumptions about UFW ingress and need a separate firewall review; no
          automatic safety is claimed.
        </p>
      )}
      {draft.stack.choice !== "dokploy" && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Docker-published ports need separate firewall review; this plan does
          not claim automatic safety for them.
        </p>
      )}
    </div>
  );
}
