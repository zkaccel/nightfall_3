# How Nightfall_3 Copes with Chain Reorganisations

A chain reorganisation happens when the local node realises that it is not in consensus with the canonical chain
and it abandons the chain branch it was operating on for the heavier canonical chain.

When this happens, there are a number of Layer 1 changes. Nightfall_3 must update its Layer 2 record so that it
is consistent with the new layer two state.

For clarity we will call the branch that is to be abandoned in favour of the new consensus the `uncle` branch
and the new, heavier branch which is part of the canonical chain, the `canonical` branch.

## The effect of a reorg on Layer 1

The transactions in the uncle branch are returned to the mempool and, from the point of view of the local node
are replaced by those in the canonical branch. Eventually they will be re-mined and this may not be in the
same order that they were originally created (although nonces are respected).  Thus dependencies between
the transactions may cause some to revert even though they worked on the uncle branch.

## The effect of a reorg on Layer 2

The L2 state is held both in Optimist and Timber (soon these will be combined). The state is updated in response
to L1 emitting blockchain events, which the L2 code listens for, for example a BlockProposed event.  These are
all defined in Structures.sol.

When a L1 chain reorg happens, the following will be seen by the listeners:

1) The events in the uncle branch will be replayed except that they will trigger a 'changed' rather than a 'data'
event type, and the event object will have a `.removed` property, which is set to `true` (NF_3 uses the property
value rather than the event type).

2) The events in the canonical branch will be played to them in the order they appear on the canonical branch.

3) The L1 transactions that were in the uncle branch will re-play as they are re-mined from the Mempool. Most
of these transactions will emit L2 events which will not necessarily be in the original order, although nonce
order for each `fromAddress` will be respected.

## Handling a chain reorg (no rollback)

When there is a reorg which does not revert a L2 rollback, the situation is simplified. We will treat this case
first.

### Layer 1 (smart contract state)

From the point of view of the local node, we see L2 Block hashes sequentially added to the blockchain record.
Suppose that the local node has the following L2 blockHash record:
```
H_0, H_1 ... H_r, H_s ... H_n
```
Let's further suppose there is a heavier chain segment out there with alternative facts:
```
H_0, H_1 ... H_r, H'_s ... H'_m
```
Note that the chains differ (fork) just after H_r.  After that point, they no longer agree on the blockchain record.

Eventually, there will be a chain reorg and the heavier branch will become the canonical chain. At that point, the
local node will agree that the correct chain is:
```
H_0, H_1 ... H_r, H'_s ... H'_m
```
and there will be a set of L1 transactions in the Mempool, corresponding to those on the now defunct uncle branch:
```
H_s ... H_n
```
The next thing that will happen is that the miners will pick up the transactions in the mempool; we say that they
will be 're-mined'.  Note however that each Block struct (see Structures.sol) contains the hash of the previous block
and the ordinal number of the block. The `proposeBlock` function checks these for correctness before adding a block hash
to the `blockHashes` array. In this case, certainly the previous block hash check and probably the block number hash
will fail and the transaction will revert.  Effectively, these uncle transactions will be cleared from the Mempool
and no state changes will result. This is exactly what we want to achieve.

Any L2 transactions that were submitted to the uncle chain will also be re-mined.  Their L1 transactions will all
succeed and they will be re-notarised to the blockchain.  They may or may not be valid depending on whether they
have dependencies on earlier transactions that no longer exist, or now occur later because they were re-mined out
of order.

### Layer 2 (Optimist)

Firstly, Optimist sees the event removals.  When it receives a BlockProposed event removal, it finds the block in its
database and sets the block's L1 block number to null.  This indicates to NF_3 that the Block hash has been removed from the L1 chain.
You might imagine we could just delete these blocks, but we can't.  We'll explain why in a bit.

*[TODO - also needs do treat nullifiers and un-stamp them?]*

Next, Optimist sees the new events (if any) come in from the canonical chain. It will check these and they should pass its
checks because they will fit on the existing blocks at the L2 blockNumber they have.

Finally, BlockProposed events will come from the re-mining of the transactions that were on the uncle branch. There
will only be these if there were no BlockProposed events on the canonical branch - otherwise the transactions
will revert at layer 1 (see previous section) and never emit an event.  

If such events do exist (and this is quite likely if there aren't many NF_3 transactions on the chain), then they will
pass the NF_3 checks and the L2 blocks will be added to the database. However, their L2 transactions will also be re-mined.
These are potentially still perfectly valid and will pass NF_3's checks. This is, however, a problem. Being valid, these L2
transactions will trigger the block assembler. This creates another block containing the same transactions (one block coming
from the re-mine, one from the block assembler).  That will be seen as a L2 transaction replay attack by Optimist. To prevent
that we:
1) trap incoming transactions (function `checkAlreadyInBlock` has this job)
2) see if they already exist in a block. If yes, check that the blocks L1 block number is null, otherwise throw a duplicate
transaction challenge. This check is why we cannot delete the removed block (above) and instead set its L1 blocknumber to null.
If we did delete the block, and these transactions were re-mined before the block containing them was re-mined, we'd think
they were new transactions.
3) If they are already in a block and we've determined they aren't really duplicates, then we set their mempool
property to `false`. That will prevent the block assembler from picking them up and creating yet another block with them in.
Eventually their original block will be re-mined, if it hasn't been already.  The timelines will be restored and
all will be well once more.

### Layer 2 (Timber)

Like Optimist, Timber firstly sees the event removals. Remember that Timber does not really understand the concept of L2 blocks
and transactions.  Therefore it simply filters L2 BlockProposed event calldata to extract commitment data, on which it operates.
When Timber receives a removal for a `BlockProposed` event, it computes the `leafCount` (number of leaves in the Merkle Tree)
which existed before the commitments in the removed block were added.  It then calls its `rollback` function to reset the
Merkle tree back to the point just before the removed L2 block's commitments were added.  This is slightly inefficient in
that it may call rollback more times than absolutely necessary. For now though, it has the benefit of simplicity.

The next thing that happens is that events from the new canonical branch are emitted.  Timber will add any commitments
associated with the `BlockProposed` events into its tree.

Finally, any re-mined `BlockProposed` events will be added.  These will only appear if they pass the L1 checks and are
compatible with the new blocks added by the canonical chain.

### Layer 2 (Client)

Client tracks the commitments owned by its user(s).  It will record whether a commitment is spent or not.  Specifically,
it remembers:

1) If a Deposit transaction has been successfully computed (`.isDeposited`)
2) If the transaction has made it on chain as part of a Block (`.isOnChain`)
3) If it has been nullified locally (`.isNullified`)
4) If the nullification has made it on chain as part of a Block (`.isNullifiedOnChain`)
5) If the commitment has been selected for spending but not yet nullified (`isPendingNullification`)

If a chain reorganisation happens then it may well change the status of some of these transactions. Changes to
the L2 Block record are relevant, this being the only event that Client subscribes to (other than the rollback which
we will consider later)  Here is specifically how Client responds:

First, the event removals are created.  If a `BlockProposed` event is removed, then we need to mark the transactions
that were in that block (assuming they are 'our' transactions and therefore in the Client database) accordingly:

#### `BlockProposed` removals
For Deposit transactions, commitment changes;
```
.isDeposited = no change
.isOnChain = -1
.isNullified = no change
.isNullifiedOnChain = no change
.isPendingNullification = no change
```
For Transfer transactions, input commitment changes (can be found by a lookup on the nullifier);
```
.isDeposited = no change
.isOnChain = -1
.isNullified = false
.isNullifiedOnChain = false
.isPendingNullification = false
```
For Transfer transactions, output commitments should be deleted because the `proposeBlock` transaction that created
them has been removed;

For withdraw transactions, the commitment is no longer nullified;
```
.isDeposited = no change
.isOnChain = -1
.isNullified = false
.isNullifiedOnChain = false
.isPendingNullification = false
```