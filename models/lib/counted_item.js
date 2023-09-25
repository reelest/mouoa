import { increment } from "firebase/firestore";
import { Item, noFirestore } from "./model";
import { InvalidState } from "./errors";
import deepEqual from "deep-equal";
import { ensureCounter } from "./counted_model";
import hasProp from "@/utils/hasProp";
import Txn from "./transaction";
import { onRefsAddItem, onRefsDeleteItem, onRefsUpdateItem } from "./trackRefs";
import {
  onSearchAddItem,
  onSearchDeleteItem,
  onSearchUpdateItem,
} from "./indexForSearch";
import {
  onFilesAddItem,
  onFilesDeleteItem,
  onFilesUpdateItem,
} from "./trackFiles";

/**
 * A counted item is an item that updates external documents when it changes.
 * It does this using transactions.
 * This is used for keeping counts, sums etc.
 */
const NO_TRANSACTION_NEEDED = 0;
const TRANSACTION_NEEDED_NO_PREV_STATE = 1;
const TRANSACTION_NEEDED = 2;
const propsNeedingUpdateTxn = Symbol("propsToUpdateTxn");

export class CountedItem extends Item {
  #needsTransaction = NO_TRANSACTION_NEEDED;
  #inUpdate = false;
  /**
   * Some keys need update transactions. This array stores the ones that have changed.
   */
  #updatedKeys = [];
  _scheduleUpdateTxn(needsPrevState, prop) {
    if (!this.#updatedKeys.includes(prop)) this.#updatedKeys.push(prop);
    if (!this.isLocalOnly())
      console.trace("Scheduling transaction for " + prop + ".....");
    this.#needsTransaction = Math.max(
      this.#needsTransaction,
      needsPrevState ? TRANSACTION_NEEDED : TRANSACTION_NEEDED_NO_PREV_STATE
    );
  }

  // eslint-disable-next-line no-unused-vars
  didUpdate(prop) {
    if (this.#needsTransaction === NO_TRANSACTION_NEEDED) return false;
    if (!this.#inUpdate)
      throw new InvalidState(
        "Checking for update keys when not in atomic update"
      );
    return this.#updatedKeys.includes(prop);
  }
  getCounter() {
    return this.model().counter;
  }

  /**
   * @param {(txn: import("firebase/firestore").Transaction, doc: ThisType)=>Promise} cb
   * @returns
   */
  async atomicUpdate(cb, needsPrevState = true, txn, prevState) {
    if (txn) {
      try {
        if (this.#inUpdate) throw InvalidState("Nested Update!!");
        this.#inUpdate = true;
        if (
          (needsPrevState || this.#needsTransaction === TRANSACTION_NEEDED) &&
          !prevState
        ) {
          const doc = await txn.get(this._ref);
          if (doc.exists()) {
            prevState = doc.data();
          } else return false;
        }
        return await cb(txn, prevState);
      } finally {
        this.#inUpdate = false;
      }
    } else {
      return Txn.run((txn) =>
        this.atomicUpdate(cb, needsPrevState, txn, prevState)
      );
    }
  }
  async _update(txn, newState, prevState = null) {
    console.log("Updating " + this.uniqueName() + "....");

    if (this[propsNeedingUpdateTxn]) {
      newState = { ...newState };
      for (let key of this[propsNeedingUpdateTxn]) {
        if (!this.#updatedKeys.includes(key)) {
          delete newState[key];
        }
      }
    }
    const ret = await this.atomicUpdate(
      async (txn, prevState) => {
        await super._update(txn, newState, prevState);
        await this.onUpdateItem(txn, newState, prevState);
      },
      this.#needsTransaction === TRANSACTION_NEEDED,
      txn,
      prevState
    );
    this.#updatedKeys.length = 0;
    this.#needsTransaction = NO_TRANSACTION_NEEDED;
    return ret;
  }
  async save(txn) {
    console.log("Saving.....");
    if (noFirestore) throw InvalidState("No Firestore!!");
    if (this.isLocalOnly()) {
      //TODO: Needs testing to assert that isLocalOnly assertion is actually true
      await ensureCounter(this.model());
      await this.atomicUpdate(
        async (txn) => {
          await super.save(txn);
          await this.onAddItem(txn, this.data());
        },
        false,
        txn,
        null
      );
    } else await super.save(txn); // Guaranteed to call _update

    this.#updatedKeys.length = 0;
    this.#needsTransaction = NO_TRANSACTION_NEEDED;
  }
  async delete(txn, prevState) {
    if (noFirestore) throw InvalidState("No Firestore!!");

    await this.atomicUpdate(
      async (txn, prevState) => {
        await super.delete(txn);
        await this.onDeleteItem(txn, prevState);
      },
      true,
      txn,
      prevState
    );
  }

  // eslint-disable-next-line no-unused-vars
  async onAddItem(txn, newState) {
    await onRefsAddItem(this, txn, newState);
    await onSearchAddItem(this, txn, newState);
    await onFilesAddItem(this, txn, newState);
    if (this.getCounter())
      this.getCounter().set(
        {
          itemCount: increment(1),
        },
        txn
      );
  }

  // eslint-disable-next-line no-unused-vars
  async onDeleteItem(txn, prevState) {
    await onRefsDeleteItem(this, txn);
    await onSearchDeleteItem(this, txn);
    await onFilesDeleteItem(this, txn, prevState);
    if (this.getCounter())
      this.getCounter().set(
        {
          itemCount: increment(-1),
        },
        txn
      );
  }

  // eslint-disable-next-line no-unused-vars
  async onUpdateItem(txn, newState, prevState) {
    await onRefsUpdateItem(this, txn, newState);
    await onSearchUpdateItem(this, txn, newState);
    await onFilesUpdateItem(this, txn, newState, prevState);
  }

  static markTriggersUpdateTxn(props, needsPrevState = true) {
    props.forEach((e) => {
      const storedValue = Symbol(e);
      const descriptor = {
        enumerable: true,
        get() {
          return this[storedValue];
        },
        set(v) {
          if (this._isCreated && !deepEqual(v, this[storedValue])) {
            console.trace(e);
            this._scheduleUpdateTxn(needsPrevState, e);
          }
          this[storedValue] = v;
        },
      };
      if (!hasProp(this.prototype, propsNeedingUpdateTxn))
        Object.defineProperty(this.prototype, propsNeedingUpdateTxn, {
          value: this[propsNeedingUpdateTxn] || [],
        });
      this.prototype[propsNeedingUpdateTxn].push(e);

      Object.defineProperty(this.prototype, e, {
        ...descriptor,
        set(v) {
          //Make this an own property so it can be picked by Object.keys
          Object.defineProperty(this, e, descriptor);
          descriptor.set.call(this, v);
        },
      });
    });
  }
}