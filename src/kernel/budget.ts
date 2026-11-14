import type { BudgetClass, ResourceAmounts } from '../contracts/types.ts';
import type { BudgetAccount } from '../contracts/runtime.ts';
import type { Store } from '../store/store.ts';
import { SwarmError, addAmounts, amounts, firstShortfall, fits, newId, subAmounts } from '../lib/util.ts';

/**
 * Hierarchical resource accounts.
 *
 * Invariant for every account A:
 *   A.consumed + Σ open children max(limit, spent) + Σ closed children spent  ≤  A.limit
 *
 * A child is carved out of what its parent still has available, inside one transaction, so
 * spawning another agent can never create additional spending authority. Closing a child
 * returns whatever it did not spend.
 */
export class Budget {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  openRoot(mission_id: string | null, owner_ref: string, limit: ResourceAmounts): BudgetAccount {
    return this.create(null, mission_id, owner_ref, 'root', limit);
  }

  /** Atomically reserve `limit` for a child out of `parent_id`. Throws `budget_exceeded` if it does not fit. */
  reserve(parent_id: string, owner_ref: string, cls: BudgetClass, limit: ResourceAmounts): BudgetAccount {
    return this.store.db.tx(() => {
      const parent = this.store.accounts.must(parent_id);
      if (parent.status !== 'open') throw new SwarmError('budget_closed', `Budget account ${parent_id} is closed`, { parent_id });
      const have = this.available(parent_id);
      if (!fits(limit, have)) {
        throw new SwarmError('budget_exceeded', `Reservation for ${owner_ref} does not fit in ${parent.owner_ref}: ${firstShortfall(limit, have)}`, {
          parent_id,
          owner_ref,
          requested: limit,
          available: have,
        });
      }
      return this.create(parent_id, parent.mission_id, owner_ref, cls, limit);
    });
  }

  private create(parent_id: string | null, mission_id: string | null, owner_ref: string, cls: BudgetClass, limit: ResourceAmounts): BudgetAccount {
    const acct: BudgetAccount = {
      id: newId('bud'),
      parent_id,
      mission_id,
      owner_ref,
      class: cls,
      limit,
      consumed: amounts(),
      status: 'open',
      created_at: this.store.clock.iso(),
      closed_at: null,
    };
    this.store.accounts.put(acct);
    this.ledger(acct.id, 'reserve', limit, owner_ref);
    return acct;
  }

  children(id: string): BudgetAccount[] {
    return this.store.accounts.where('"parent_id" = ?', id);
  }

  /** Everything spent by this account and all of its descendants. */
  spent(id: string): ResourceAmounts {
    const acct = this.store.accounts.must(id);
    let total = acct.consumed;
    for (const c of this.children(id)) total = addAmounts(total, this.spent(c.id));
    return total;
  }

  /** What this account can still hand out or spend itself. */
  available(id: string): ResourceAmounts {
    const acct = this.store.accounts.must(id);
    let committed = acct.consumed;
    for (const c of this.children(id)) {
      const spent = this.spent(c.id);
      if (c.status === 'open') {
        // An open child holds its whole reservation, or more if it overran.
        committed = addAmounts(committed, maxAmounts(c.limit, spent));
      } else {
        committed = addAmounts(committed, spent);
      }
    }
    return subAmounts(acct.limit, committed);
  }

  /**
   * Record actual consumption. Usage is recorded truthfully even when it exceeds the reservation;
   * the overrun is reported so the caller can stop further dispatch on this account.
   */
  consume(id: string, used: ResourceAmounts, ref: string): { over: boolean; shortfall: string | null } {
    return this.store.db.tx(() => {
      const acct = this.store.accounts.must(id);
      acct.consumed = addAmounts(acct.consumed, used);
      this.store.accounts.put(acct);
      this.ledger(id, 'consume', used, ref);
      const shortfall = firstShortfall(acct.consumed, acct.limit);
      return { over: shortfall !== null, shortfall };
    });
  }

  /**
   * Move unspent allowance from one account to another. The allowance is moved, not spent: every
   * account between the giver and the nearest common ancestor narrows by the amount, and every
   * account between the receiver and that ancestor widens by it, so no account ever holds more
   * than its parent gave it and nothing is recorded as consumed. Returns false, changing nothing,
   * when the giver does not have that much available or an account on the way is closed.
   */
  transfer(from_id: string, to_id: string, amt: ResourceAmounts, ref: string): boolean {
    return this.store.db.tx(() => {
      const chain = (id: string): BudgetAccount[] => {
        const out: BudgetAccount[] = [];
        for (let a: BudgetAccount | undefined = this.store.accounts.must(id); a; a = a.parent_id ? this.store.accounts.must(a.parent_id) : undefined) out.push(a);
        return out;
      };
      const giving = chain(from_id);
      const receiving = chain(to_id);
      const common = receiving.find((a) => giving.some((g) => g.id === a.id));
      if (!common) return false;
      const narrow = giving.slice(0, giving.findIndex((a) => a.id === common.id));
      const widen = receiving.slice(0, receiving.findIndex((a) => a.id === common.id));
      if ([...narrow, ...widen].some((a) => a.status !== 'open')) return false;
      if (!fits(amt, this.available(from_id))) return false;
      for (const a of narrow) {
        a.limit = subAmounts(a.limit, amt);
        this.store.accounts.put(a);
        this.ledger(a.id, 'transfer_out', amt, ref);
      }
      for (const a of widen) {
        a.limit = addAmounts(a.limit, amt);
        this.store.accounts.put(a);
        this.ledger(a.id, 'transfer_in', amt, ref);
      }
      return true;
    });
  }

  close(id: string): ResourceAmounts {
    return this.store.db.tx(() => {
      const acct = this.store.accounts.must(id);
      if (acct.status === 'closed') return amounts();
      for (const c of this.children(id)) this.close(c.id);
      acct.status = 'closed';
      acct.closed_at = this.store.clock.iso();
      this.store.accounts.put(acct);
      const released = subAmounts(acct.limit, this.spent(id));
      this.ledger(id, 'release', released, acct.owner_ref);
      return released;
    });
  }

  /**
   * Reopen a closed account because its work has to be redone. What it had released went back to
   * its parent, so it can only be reopened if the parent still has that much available.
   * Closed ancestors are reopened first. Returns false when the money is no longer there.
   */
  reopen(id: string): boolean {
    return this.store.db.tx(() => {
      const acct = this.store.accounts.must(id);
      if (acct.status === 'open') return true;
      if (acct.parent_id) {
        if (!this.reopen(acct.parent_id)) return false;
        const need = subAmounts(maxAmounts(acct.limit, this.spent(id)), this.spent(id));
        if (!fits(need, this.available(acct.parent_id))) return false;
      }
      acct.status = 'open';
      acct.closed_at = null;
      this.store.accounts.put(acct);
      this.ledger(id, 'reopen', subAmounts(acct.limit, this.spent(id)), acct.owner_ref);
      return true;
    });
  }

  /** Rebuild consumption and limits from the ledger and compare with stored aggregates across the whole tree. */
  reconcile(root_id: string): { ok: boolean; discrepancies: string[]; accounts: number } {
    const discrepancies: string[] = [];
    let accounts = 0;
    const visit = (id: string): void => {
      accounts++;
      const acct = this.store.accounts.must(id);
      const rows = this.store.db.all<{ kind: string; amounts: string }>(`SELECT kind, amounts FROM budget_ledger WHERE account_id = ? ORDER BY seq`, id);
      let fromLedger = amounts();
      let limit: ResourceAmounts | null = null;
      for (const r of rows) {
        const a = JSON.parse(r.amounts) as ResourceAmounts;
        if (r.kind === 'consume') fromLedger = addAmounts(fromLedger, a);
        else if (r.kind === 'reserve' && !limit) limit = a;
        else if (r.kind === 'transfer_in' && limit) limit = addAmounts(limit, a);
        else if (r.kind === 'transfer_out' && limit) limit = subAmounts(limit, a);
      }
      if (!sameAmounts(fromLedger, acct.consumed)) {
        discrepancies.push(`${acct.owner_ref}: stored consumption differs from ledger`);
      }
      if (!limit || !sameAmounts(limit, acct.limit)) {
        discrepancies.push(`${acct.owner_ref}: stored limit differs from ledger`);
      }
      const short = firstShortfall(amounts(), this.available(id));
      if (short) discrepancies.push(`${acct.owner_ref}: over-committed (${short})`);
      for (const c of this.children(id)) visit(c.id);
    };
    visit(root_id);
    return { ok: discrepancies.length === 0, discrepancies, accounts };
  }

  private ledger(account_id: string, kind: string, amt: ResourceAmounts, ref: string): void {
    this.store.db.run('INSERT INTO budget_ledger (account_id, kind, amounts, ref, ts) VALUES (?, ?, ?, ?, ?)', account_id, kind, JSON.stringify(amt), ref, this.store.clock.iso());
  }
}

/** Equal to within floating-point noise: cost estimates are sums of fractions. */
function sameAmounts(a: ResourceAmounts, b: ResourceAmounts): boolean {
  const near = (x: number, y: number): boolean => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  return near(a.model_calls, b.model_calls) && near(a.worker_invocations, b.worker_invocations) && near(a.tokens, b.tokens) && near(a.cost_usd_est, b.cost_usd_est) && near(a.wall_ms, b.wall_ms);
}

function maxAmounts(a: ResourceAmounts, b: ResourceAmounts): ResourceAmounts {
  return {
    model_calls: Math.max(a.model_calls, b.model_calls),
    worker_invocations: Math.max(a.worker_invocations, b.worker_invocations),
    tokens: Math.max(a.tokens, b.tokens),
    cost_usd_est: Math.max(a.cost_usd_est, b.cost_usd_est),
    wall_ms: Math.max(a.wall_ms, b.wall_ms),
  };
}
