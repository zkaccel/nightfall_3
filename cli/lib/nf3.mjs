import axios from 'axios';
import Web3 from 'web3';
import WebSocket from 'ws';
import EventEmitter from 'events';
import { generateKeys } from '../../nightfall-client/src/services/keys.mjs';

/**
@class
Creates a new Nightfall_3 library instance.
@param {string} clientBaseUrl - The base url for nightfall-client
@param {string} optimistBaseUrl - The base url for nightfall-optimist
@param {string} optimistWsUrl - The webscocket url for nightfall-optimist
@param {string} web3WsUrl - The websocket url for the web3js client
@param {string} ethereumSigningKey - the Ethereum siging key to be used for transactions (hex string).
@param {object} zkpKeys - An object containing the zkp keys to use.  These will be auto-generated if left undefined.
*/
class Nf3 {
  clientBaseUrl;

  optimistBaseUrl;

  optimistWsUrl;

  web3WsUrl;

  web3;

  shieldContractAddress;

  proposersContractAddress;

  challengesContractAddress;

  stateContractAddress;

  ethereumSigningKey;

  ethereumAddress;

  zkpKeys;

  defaultFee = 10;

  PROPOSER_BOND = 10000000000000000000;

  BLOCK_STAKE = 1000000000000000000; // 1 ether

  constructor(
    clientBaseUrl,
    optimistBaseUrl,
    optimistWsUrl,
    web3WsUrl,
    ethereumSigningKey,
    zkpKeys,
  ) {
    this.clientBaseUrl = clientBaseUrl;
    this.optimistBaseUrl = optimistBaseUrl;
    this.optimistWsUrl = optimistWsUrl;
    this.web3WsUrl = web3WsUrl;
    this.ethereumSigningKey = ethereumSigningKey;
    this.zkpKeys = zkpKeys;
  }

  /**
  Initialises the Nf_3 object so that it can communicate with Nightfall_3 and the
  blockchain.
  @returns {Promise}
  */
  async init() {
    this.web3 = new Web3(this.web3WsUrl);
    this.zkpKeys = this.zkpKeys || (await generateKeys());
    this.shieldContractAddress = await this.getContractAddress('Shield');
    this.proposersContractAddress = await this.getContractAddress('Proposers');
    this.challengesContractAddress = await this.getContractAddress('Challenges');
    this.stateContractAddress = await this.getContractAddress('State');
    // set the ethereumAddress iff we have a signing key
    if (this.ethereumSigningKey)
      this.ethereumAddress = this.web3.eth.accounts.privateKeyToAccount(
        this.ethereumSigningKey,
      ).address;
    return this.subscribeToIncomingViewingKeys();
  }

  /**
  Setter for the ethereum private key, in case it wasn't known at build time.
  This will also update the corresponding Ethereum address that Nf_3 uses.
  @method
  @param {string} key - the ethereum private key as a hex string.
  */
  setEthereumSigningKey(key) {
    this.ethereumSigningKey = key;
    this.ethereumAddress = this.web3.eth.accounts.privateKeyToAccount(
      this.ethereumSigningKey,
    ).address;
  }

  /**
  Setter for the zkp keys, in case it wasn't known at build time and we don't
  want to use autogenerated ones.
  @method
  @param {object} keys - The zkp keys object.
  */
  setzkpKeys(keys) {
    this.zkpKeys = keys;
  }

  /**
  Method for signing and submitting an Ethereum transaction to the
  blockchain.
  @method
  @async
  @param {object} unsignedTransaction - An unsigned web3js transaction object.
  @param {string} shieldContractAddress - The address of the Nightfall_3 shield address.
  @param {number} fee - the value of the transaction.
  This can be found using the getContractAddress convenience function.
  @returns {Promise} This will resolve into a transaction receipt.
  */
  async submitTransaction(
    unsignedTransaction,
    contractAddress = this.shieldContractAddress,
    fee = this.defaultFee,
  ) {
    const nonce = await this.web3.eth.getTransactionCount(this.ethereumAddress);
    const tx = {
      to: contractAddress,
      data: unsignedTransaction,
      value: fee,
      gas: 10000000,
      gasPrice: 10000000000,
      nonce,
    };
    const signed = await this.web3.eth.accounts.signTransaction(tx, this.ethereumSigningKey);
    return this.web3.eth.sendSignedTransaction(signed.rawTransaction);
  }

  /**
  Determines if a Nightfall_3 server is running and healthy.
  @method
  @async
  @param {string} server - The name of the server being checked ['client', 'optimist']
  @returns {Promise} This will resolve into a boolean - true if the healthcheck passed.
  */
  async healthcheck(server) {
    let url;
    switch (server) {
      case 'client':
        url = this.clientBaseUrl;
        break;
      case 'optimist':
        url = this.optimistBaseUrl;
        break;
      default:
        throw new Error('Unknown server name');
    }
    let res;
    try {
      res = await axios.get(`${url}/healthcheck`);
      if (res.status !== 200) return false;
    } catch (err) {
      return false;
    }
    return true;
  }

  /**
  Returns the address of a Nightfall_3 contract.
  @method
  @async
  @param {string} contractName - the name of the smart contract in question. Possible
  values are 'Shield', 'State', 'Proposers', 'Challengers'.
  @returns {Promise} Resolves into the Ethereum address of the contract
  */
  async getContractAddress(contractName) {
    const res = await axios.get(`${this.clientBaseUrl}/contract-address/${contractName}`);
    return res.data.address;
  }

  /**
  Deposits a Layer 1 token into Layer 2, so that it can be transacted
  privately.
  @method
  @async
  @param {number} fee - The amount (Wei) to pay a proposer for the transaction
  @param {string} ercAddress - The address of the ERCx contract from which the token
  is being taken.  Note that the Nightfall_3 State.sol contract must be approved
  by the token's owner to be able to withdraw the token.
  @param {string} tokenType - The type of token to deposit. Possible values are
  'ERC20', 'ERC721', 'ERC1155'.
  @param {number} value - The value of the token, in the case of an ERC20 or ERC1155
  token.  For ERC721 this should be set to zero.
  @param {string} tokenId - The ID of an ERC721 or ERC1155 token.  In the case of
  an 'ERC20' coin, this should be set to '0x00'.
  @param {object} keys - The ZKP private key set.
  @returns {Promise} Resolves into the Ethereum transaction receipt.
  */
  async deposit(ercAddress, tokenType, value, tokenId, fee = this.defaultFee) {
    const res = await axios.post(`${this.clientBaseUrl}/deposit`, {
      ercAddress,
      tokenId,
      tokenType,
      value,
      pkd: this.zkpKeys.pkd,
      nsk: this.zkpKeys.nsk,
      fee,
    });
    return this.submitTransaction(res.data.txDataToSign, this.shieldContractAddress, fee);
  }

  /**
  Transfers a token within Layer 2.
  @method
  @async
  @param {number} fee - The amount (Wei) to pay a proposer for the transaction
  @param {string} ercAddress - The address of the ERCx contract from which the token
  is being taken.  Note that the Nightfall_3 State.sol contract must be approved
  by the token's owner to be able to withdraw the token.
  @param {string} tokenType - The type of token to deposit. Possible values are
  'ERC20', 'ERC721', 'ERC1155'.
  @param {number} value - The value of the token, in the case of an ERC20 or ERC1155
  token.  For ERC721 this should be set to zero.
  @param {string} tokenId - The ID of an ERC721 or ERC1155 token.  In the case of
  an 'ERC20' coin, this should be set to '0x00'.
  @param {object} keys - The ZKP private key set of the sender.
  @param {array} pkd - The transmission key of the recipient (this is a curve point
  represented as an array of two hex strings).
  @returns {Promise} Resolves into the Ethereum transaction receipt.
  */
  async transfer(ercAddress, tokenType, value, tokenId, pkd, fee = this.defaultFee) {
    const res = await axios.post(`${this.clientBaseUrl}/transfer`, {
      ercAddress,
      tokenId,
      recipientData: {
        values: [value],
        recipientPkds: [pkd],
      },
      nsk: this.zkpKeys.nsk,
      ask: this.zkpKeys.ask,
      fee,
    });
    return this.submitTransaction(res.data.txDataToSign, this.shieldContractAddress, fee);
  }

  /**
  Withdraws a token from Layer 2 back to Layer 1. It can then be withdrawn from
  the Shield contract's account by the owner in Layer 1.
  @method
  @async
  @param {number} fee - The amount (Wei) to pay a proposer for the transaction
  @param {string} ercAddress - The address of the ERCx contract from which the token
  is being taken.  Note that the Nightfall_3 State.sol contract must be approved
  by the token's owner to be able to withdraw the token.
  @param {string} tokenType - The type of token to deposit. Possible values are
  'ERC20', 'ERC721', 'ERC1155'.
  @param {number} value - The value of the token, in the case of an ERC20 or ERC1155
  token.  For ERC721 this should be set to zero.
  @param {string} tokenId - The ID of an ERC721 or ERC1155 token.  In the case of
  an 'ERC20' coin, this should be set to '0x00'.
  @param {object} keys - The ZKP private key set of the sender.
  @param {string} recipientAddress - The Ethereum address to where the withdrawn tokens
  should be deposited.
  @returns {Promise} Resolves into the Ethereum transaction receipt.
  */
  async withdraw(ercAddress, tokenType, value, tokenId, recipientAddress, fee = this.defaultFee) {
    const res = await axios.post(`${this.clientBaseUrl}/withdraw`, {
      ercAddress,
      tokenId,
      tokenType,
      value,
      recipientAddress,
      nsk: this.zkpKeys.nsk,
      ask: this.zkpKeys.ask,
      fee,
    });
    return this.submitTransaction(res.data.txDataToSign, this.shieldContractAddress, fee);
  }

  /**
  Provides nightfall-client with a set of viewing keys.  Without these,
  it won't listen for BlockProposed events and so won't update its transaction collection
  with information about which are on-line.
  @method
  @async
  @param {object} keys - Object containing the ZKP key set (this may be generated
  with the makeKeys function).
  */
  async subscribeToIncomingViewingKeys() {
    return axios.post(`${this.clientBaseUrl}/incoming-viewing-key`, {
      ivk: this.zkpKeys.ivk,
      nsk: this.zkpKeys.nsk,
    });
  }

  /**
  Closes the Nf3 connection to the blockchain
  @method
  @async
  */
  close() {
    this.web3.currentProvider.connection.close();
  }

  /**
  Registers a new proposer and pays the Bond required to register.
  It will use the address of the Ethereum Signing key that is holds to register
  the proposer.
  @method
  @async
  @returns {Promise} A promise that resolves to the Ethereum transaction receipt.
  */
  async registerProposer() {
    const res = await axios.post(`${this.optimistBaseUrl}/proposer/register`, {
      address: this.ethereumAddress,
    });
    return this.submitTransaction(
      res.data.txDataToSign,
      this.proposersContractAddress,
      this.PROPOSER_BOND,
    );
  }

  /**
  Starts a Proposer that listens for blocks and submits block proposal
  transactions to the blockchain.
  @method
  @async
  */
  async startProposer() {
    const connection = new WebSocket(this.optimistWsUrl);
    connection.onopen = () => {
      connection.send('blocks');
    };
    connection.onmessage = async message => {
      const msg = JSON.parse(message.data);
      const { type, txDataToSign } = msg;
      if (type === 'block') {
        await this.submitTransaction(txDataToSign, this.stateContractAddress, this.BLOCK_STAKE);
      }
    };
  }

  /**
  Returns an emitter, whose 'on' event fires whenever a block is
  detected, passing out the transaction needed to propose the block. This
  is a lower level method than `Nf3.startProposer` because it does not sign and
  send the transaction to the blockchain. If required, `Nf3.submitTransaction`
  can be used to do that.
  @method
  @async
  @returns {Promise} A Promise that resolves into an event emitter.
  */
  async getNewBlockEmitter() {
    const newBlockEmitter = new EventEmitter();
    const connection = new WebSocket(this.optimistWsUrl);
    connection.onopen = () => {
      connection.send('blocks');
    };
    connection.onmessage = async message => {
      const msg = JSON.parse(message.data);
      const { type, txDataToSign } = msg;
      if (type === 'block') {
        newBlockEmitter.emit('on', txDataToSign);
      }
    };
    return newBlockEmitter;
  }

  /**
  Registers our address as a challenger address with the optimist container.
  This is so that the optimist container can tell when a challenge that we have
  committed to has appeared on chain.
  @method
  @async
  @return {Promise} A promise that resolves to an axios response.
  */
  async registerChallenger() {
    return axios.post(`${this.optimistBaseUrl}/challenger/add`, { address: this.ethereumAddress });
  }

  /**
  Starts a Challenger that listens for challengable blocks and submits challenge
  transactions to the blockchain to challenge the block.
  @method
  @async
  */
  async startChallenger() {
    const connection = new WebSocket(this.optimistWsUrl);
    connection.onopen = () => {
      connection.send('challenge');
    };
    connection.onmessage = async message => {
      const msg = JSON.parse(message.data);
      const { type, txDataToSign } = msg;
      if (type === 'challenge') {
        await this.submitTransaction(txDataToSign, this.stateContractAddress, 0);
      }
    };
  }

  /**
  Returns an emitter, whose 'on' event fires whenever a challengeable block is
  detected, passing out the transaction needed to raise the challenge. This
  is a lower level method than `Nf3.startChallenger` because it does not sign and
  send the transaction to the blockchain. If required, `Nf3.submitTransaction`
  can be used to do that.
  @method
  @async
  @returns {Promise} A Promise that resolves into an event emitter.
  */
  async getChallengeEmitter() {
    const newChallengeEmitter = new EventEmitter();
    const connection = new WebSocket(this.optimistWsUrl);
    connection.onopen = () => {
      connection.send('blocks');
    };
    connection.onmessage = async message => {
      const msg = JSON.parse(message.data);
      const { type, txDataToSign } = msg;
      if (type === 'challenge') {
        newChallengeEmitter.emit('on', txDataToSign);
      }
    };
    return newChallengeEmitter;
  }

  /**
  Returns the balance of tokens held in layer 2
  @method
  @async
  @returns {Promise} This promise rosolves into an object whose properties are the
  addresses of the ERC contracts of the tokens held by this account in Layer 2. The
  value of each propery is the number of tokens originating from that contract.
  */
  async getLayer2Balances() {
    const res = await axios.get(`${this.clientBaseUrl}/commitment/balance`);
    return res.data.balance;
  }
}

export default Nf3;
