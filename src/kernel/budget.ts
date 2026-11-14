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

  /** Rebuild consumption from the ledger and compare with stored aggregates across the whole tree. */
  reconcile(root_id: string): { ok: boolean; discrepancies: string[]; accounts: number } {
    const discrepancies: string[] = [];
    let accounts = 0;
    const visit = (id: string): void => {
      accounts++;
      const acct = this.store.accounts.must(id);
      const rows = this.store.db.all<{ amounts: string }>(`SELECT amounts FROM budget_ledger WHERE account_id = ? AND kind = 'consume'`, id);
      let fromLedger = amounts();
      for (const r of rows) fromLedger = addAmounts(fromLedger, JSON.parse(r.amounts) as ResourceAmounts);
      if (JSON.stringify(fromLedger) !== JSON.stringify(acct.consumed)) {
        discrepancies.push(`${acct.owner_ref}: stored consumption differs from ledger`);
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

function maxAmounts(a: ResourceAmounts, b: ResourceAmounts): ResourceAmounts {
  return {
    model_calls: Math.max(a.model_calls, b.model_calls),
    worker_invocations: Math.max(a.worker_invocations, b.worker_invocations),
    tokens: Math.max(a.tokens, b.tokens),
    cost_usd_est: Math.max(a.cost_usd_est, b.cost_usd_est),
    wall_ms: Math.max(a.wall_ms, b.wall_ms),
  };
}
