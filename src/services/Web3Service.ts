import Web3 from "web3";
import { Contract } from 'web3-eth-contract';

import { Service } from "../decorators";
import { Injections } from "../constants";
import { network } from "../constants";
import { ABI } from "../abi/FanPiao";

@Service(Injections.Web3Service)
export class Web3Service {
    private web3: Web3;
    private contracts: Map<string, Contract>;

    constructor() {
        this.web3 = new Web3(new Web3.providers.HttpProvider(network));
        this.contracts = new Map<string, Contract>();
    }

    checkAddressChecksum(address: string, chainId?: number) {
        return this.web3.utils.checkAddressChecksum(address, chainId);
    }
    fromWeiToEther(number: string) {
        return this.web3.utils.fromWei(number, "ether");
    }

    getBalance(contractAddress: string, walletAddress: string) {
        let contract = this.contracts.get(contractAddress);
        if (!contract) {
            contract = new this.web3.eth.Contract(ABI, contractAddress);
            this.contracts.set(contractAddress, contract);
        }

        return contract.methods.balanceOf(walletAddress).call();
    }
}
