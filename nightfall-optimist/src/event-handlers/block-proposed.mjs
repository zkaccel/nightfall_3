import logger from 'common-files/utils/logger.mjs';
import Timber from 'common-files/classes/timber.mjs';
import config from 'config';
import checkBlock from '../services/check-block.mjs';
import BlockError from '../classes/block-error.mjs';
import { createChallenge } from '../services/challenges.mjs';
import {
  removeTransactionsFromMemPool,
  saveBlock,
  stampNullifiers,
  getLatestTree,
  saveTree,
} from '../services/database.mjs';
import { getProposeBlockCalldata } from '../services/process-calldata.mjs';

const { ZERO } = config;
/**
This handler runs whenever a BlockProposed event is emitted by the blockchain
*/
async function blockProposedEventHandler(data) {
  const { blockNumber: currentBlockCount, transactionHash: transactionHashL1 } = data;
  const { block, transactions } = await getProposeBlockCalldata(data);
  logger.info('Received BlockProposed event');
  try {
    // and save the block to facilitate later lookup of block data
    // we will save before checking because the database at any time should reflect the state the blockchain holds
    // when a challenge is raised because the is correct block data, then the corresponding block deleted event will
    // update this collection
    await saveBlock({ blockNumber: currentBlockCount, transactionHashL1, ...block });
    // Update the nullifiers we have stored, with the blockhash. These will
    // be deleted if the block check fails and we get a rollback.  We do this
    // before running the block check because we want to delete the nullifiers
    // asociated with a failed block, and we can't do that if we haven't
    // associated them with a blockHash.
    await stampNullifiers(
      transactions
        .map(tx =>
          tx.nullifiers.filter(
            nulls => nulls !== '0x0000000000000000000000000000000000000000000000000000000000000000',
          ),
        )
        .flat(Infinity),
      block.blockHash,
    );
    // mark transactions so that they are out of the mempool,
    // so we don't try to use them in a block which we're proposing.
    await removeTransactionsFromMemPool(block); // TODO is await needed?

    const latestTree = await getLatestTree();
    const blockCommitments = transactions.map(t => t.commitments.filter(c => c !== ZERO)).flat();
    const updatedTimber = Timber.statelessUpdate(latestTree, blockCommitments);
    // latestTree.insertLeaves(blockCommitments);
    // logger.info(`latestTree leafCount: ${latestTree.leafCount}`);
    const res = await saveTree(currentBlockCount, block.blockNumberL2, updatedTimber);
    logger.debug(`Saving tree with block number ${block.blockNumberL2}, ${res}`);
    // signal to the block-making routines that a block is received: they
    // won't make a new block until their previous one is stored on-chain.
    // we'll check the block and issue a challenge if appropriate
    await checkBlock(block, transactions);
    logger.info('Block Checker - Block was valid');
  } catch (err) {
    if (err instanceof BlockError) {
      logger.warn(`Block Checker - Block invalid, with code ${err.code}! ${err.message}`);
      await createChallenge(block, transactions, err);
    } else {
      logger.error(err.stack);
      throw new Error(err);
    }
  }
}

export default blockProposedEventHandler;
