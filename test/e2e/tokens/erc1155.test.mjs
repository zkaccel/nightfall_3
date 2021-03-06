/* eslint-disable no-await-in-loop */

import chai from 'chai';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';
import config from 'config';
import Nf3 from '../../../cli/lib/nf3.mjs';
import logger from '../../../common-files/utils/logger.mjs';
import { expectTransaction, Web3Client, depositNTransactions } from '../../utils.mjs';
import { getERCInfo } from '../../../cli/lib/tokens.mjs';

// so we can use require with mjs file
const { expect } = chai;
chai.use(chaiHttp);
chai.use(chaiAsPromised);

const environment = config.ENVIRONMENTS[process.env.ENVIRONMENT] || config.ENVIRONMENTS.localhost;

const {
  fee,
  txPerBlock,
  transferValue,
  tokenConfigs: { tokenTypeERC1155, tokenType, tokenId },
  mnemonics,
  signingKeys,
} = config.TEST_OPTIONS;

const nf3Users = [new Nf3(signingKeys.user1, environment), new Nf3(signingKeys.user2, environment)];
const nf3Proposer1 = new Nf3(signingKeys.proposer1, environment);

const web3Client = new Web3Client();

let erc1155Address;
// why do we need an ERC20 token in an ERC1155 test, you ask?
// let me tell you I also don't know, but I guess we just want to fill some blocks?
let erc20Address;
let stateAddress;
let eventLogs = [];
let availableTokenIds;

/*
  This function tries to zero the number of unprocessed transactions in the optimist node
  that nf3 is connected to. We call it extensively on the tests, as we want to query stuff from the
  L2 layer, which is dependent on a block being made. We also need 0 unprocessed transactions by the end
  of the tests, otherwise the optimist will become out of sync with the L2 block count on-chain.
*/
const emptyL2 = async nf3Instance => {
  let count = await nf3Instance.unprocessedTransactionCount();
  while (count !== 0) {
    if (count % txPerBlock) {
      await depositNTransactions(
        nf3Instance,
        count % txPerBlock ? count % txPerBlock : txPerBlock,
        erc20Address,
        tokenType,
        transferValue,
        tokenId,
        fee,
      );

      eventLogs = await web3Client.waitForEvent(eventLogs, ['blockProposed']);
    } else {
      eventLogs = await web3Client.waitForEvent(eventLogs, ['blockProposed']);
    }

    count = await nf3Instance.unprocessedTransactionCount();
  }

  await depositNTransactions(
    nf3Instance,
    txPerBlock,
    erc20Address,
    tokenType,
    transferValue,
    tokenId,
    fee,
  );
  eventLogs = await web3Client.waitForEvent(eventLogs, ['blockProposed']);
};

describe('ERC1155 tests', () => {
  before(async () => {
    await nf3Proposer1.init(mnemonics.proposer);
    await nf3Proposer1.registerProposer();

    // Proposer listening for incoming events
    const newGasBlockEmitter = await nf3Proposer1.startProposer();
    newGasBlockEmitter.on('gascost', async gasUsed => {
      logger.debug(
        `Block proposal gas cost was ${gasUsed}, cost per transaction was ${gasUsed / txPerBlock}`,
      );
    });

    await nf3Users[0].init(mnemonics.user1);
    await nf3Users[1].init(mnemonics.user2);
    erc20Address = await nf3Users[0].getContractAddress('ERC20Mock');
    erc1155Address = await nf3Users[0].getContractAddress('ERC1155Mock');

    stateAddress = await nf3Users[0].stateContractAddress;
    web3Client.subscribeTo('logs', eventLogs, { address: stateAddress });

    const availableTokens = (
      await getERCInfo(erc1155Address, nf3Users[0].ethereumAddress, web3Client.getWeb3(), {
        details: true,
      })
    ).details;

    availableTokenIds = availableTokens.map(t => t.tokenId);

    for (let i = 0; i < txPerBlock * 2; i++) {
      await nf3Users[0].deposit(
        erc1155Address,
        tokenTypeERC1155,
        transferValue,
        availableTokenIds[0],
        fee,
      );
    }
    eventLogs = await web3Client.waitForEvent(eventLogs, ['blockProposed'], 2);

    await emptyL2(nf3Users[0]);
  });

  afterEach(async () => {
    await emptyL2(nf3Users[0]);
  });

  describe('Deposit', () => {
    it('should deposit some ERC1155 crypto into a ZKP commitment', async function () {
      let balances = await nf3Users[0].getLayer2Balances();
      const balanceBefore = [
        balances[erc1155Address]?.find(e => e.tokenId === 0)?.balance || 0,
        balances[erc1155Address]?.find(e => e.tokenId === 1)?.balance || 0,
      ];
      // We create enough transactions to fill blocks full of deposits.
      let res = await nf3Users[0].deposit(
        erc1155Address,
        tokenTypeERC1155,
        transferValue,
        availableTokenIds[0],
        fee,
      );
      expectTransaction(res);

      res = await nf3Users[0].deposit(
        erc1155Address,
        tokenTypeERC1155,
        transferValue,
        availableTokenIds[1],
        fee,
      );
      expectTransaction(res);
      // Wait until we see the right number of blocks appear
      eventLogs = await web3Client.waitForEvent(eventLogs, ['blockProposed']);

      await emptyL2(nf3Users[0]);
      balances = await nf3Users[0].getLayer2Balances();

      const balanceAfter = [
        balances[erc1155Address]?.find(e => e.tokenId === 0).balance,
        balances[erc1155Address]?.find(e => e.tokenId === 1).balance,
      ];

      expect(balanceAfter[0] - balanceBefore[0]).to.be.equal(transferValue);
      expect(balanceAfter[1] - balanceBefore[1]).to.be.equal(transferValue);
    });

    it('should deposit some ERC1155 crypto into a ZKP commitment and make a block with a single transaction', async function () {
      // We create enough transactions to fill blocks full of deposits.
      const res0 = await nf3Proposer1.makeBlockNow();
      expect(res0.data).to.be.equal('Making short block');
      const res = await nf3Users[0].deposit(
        erc1155Address,
        tokenTypeERC1155,
        transferValue,
        availableTokenIds[2],
        fee,
      );
      expectTransaction(res);

      // Wait until we see the right number of blocks appear
      eventLogs = await web3Client.waitForEvent(eventLogs, ['blockProposed']);

      await emptyL2(nf3Users[0]);
    });
  });

  describe('Transfer', () => {
    it('should decrement the balance after transfer ERC1155 to other wallet and increment the other wallet', async function () {
      let balances;
      async function getBalances() {
        balances = [
          (await nf3Users[0].getLayer2Balances())[erc1155Address].find(e => e.tokenId === 0)
            .balance,
          (await nf3Users[1].getLayer2Balances())[erc1155Address]?.find(e => e.tokenId === 0)
            ?.balance || 0,
        ];
      }

      await getBalances();
      // weird way to clone an array, but we need a deep clone as it's a multidimensional array
      const beforeBalances = JSON.parse(JSON.stringify(balances));

      for (let i = 0; i < txPerBlock; i++) {
        const res = await nf3Users[0].transfer(
          false,
          erc1155Address,
          tokenTypeERC1155,
          transferValue,
          availableTokenIds[0],
          nf3Users[1].zkpKeys.compressedPkd,
          fee,
        );
        expectTransaction(res);
      }
      eventLogs = await web3Client.waitForEvent(eventLogs, ['blockProposed']);

      await getBalances();

      expect(balances[0] - beforeBalances[0]).to.be.equal(-transferValue * txPerBlock);
      expect(balances[1] - beforeBalances[1]).to.be.equal(transferValue * txPerBlock);
    });
  });

  describe('Withdraw', () => {
    it('should withdraw from L2, checking for missing commitment', async function () {
      const beforeBalance = (await nf3Users[0].getLayer2Balances())[erc1155Address].find(
        e => e.tokenId === 0,
      ).balance;

      const rec = await nf3Users[0].withdraw(
        false,
        erc1155Address,
        tokenTypeERC1155,
        transferValue,
        availableTokenIds[0],
        nf3Users[0].ethereumAddress,
      );
      expectTransaction(rec);
      logger.debug(`     Gas used was ${Number(rec.gasUsed)}`);

      await emptyL2(nf3Users[0]);

      const balanceAfter =
        (await nf3Users[0].getLayer2Balances())[erc1155Address]?.find(e => e.tokenId === 0)
          ?.balance || 0;

      expect(balanceAfter).to.be.lessThan(beforeBalance);
    });

    it('should withdraw from L2, checking for L1 balance (only with time-jump client)', async function () {
      const nodeInfo = await web3Client.getInfo();
      if (nodeInfo.includes('TestRPC')) {
        const beforeBalance = (await nf3Users[0].getLayer2Balances())[erc1155Address]?.find(
          e => e.tokenId === 0,
        )?.balance;

        const rec = await nf3Users[0].withdraw(
          false,
          erc1155Address,
          tokenTypeERC1155,
          transferValue,
          availableTokenIds[0],
          nf3Users[0].ethereumAddress,
        );
        expectTransaction(rec);
        const withdrawal = await nf3Users[0].getLatestWithdrawHash();

        await emptyL2(nf3Users[0]);

        await web3Client.timeJump(3600 * 24 * 10); // jump in time by 50 days

        const commitments = await nf3Users[0].getPendingWithdraws();

        expect(
          commitments[nf3Users[0].zkpKeys.compressedPkd][erc1155Address].length,
        ).to.be.greaterThan(0);
        expect(
          commitments[nf3Users[0].zkpKeys.compressedPkd][erc1155Address].filter(
            c => c.valid === true,
          ).length,
        ).to.be.greaterThan(0);

        const res = await nf3Users[0].finaliseWithdrawal(withdrawal);
        expectTransaction(res);

        const endBalance = (await nf3Users[0].getLayer2Balances())[erc1155Address]?.find(
          e => e.tokenId === 0,
        )?.balance;
        expect(endBalance).to.be.lessThan(beforeBalance);
      } else {
        console.log('     Not using a time-jump capable test client so this test is skipped');
        this.skip();
      }
    });
  });

  after(async () => {
    await nf3Proposer1.deregisterProposer();
    await nf3Proposer1.close();
    await nf3Users[0].close();
    await nf3Users[1].close();
    await web3Client.closeWeb3();
  });
});
