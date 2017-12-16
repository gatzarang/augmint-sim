// keeps track of loans

'use strict';

const augmint = require('./augmint.js');
const clock = require('../lib/clock.js');
const logger = require('../lib/logger.js');

const ONE_DAY_IN_SECS = 24 * 60 * 60;
const loanProducts = augmint.loanProducts;
const loans = augmint.loans;
// just gonna use a counter for id-ing loans:
let counter = 0;

function createLoanProduct(
    minimumLoanInAcd,
    loanCollateralRatio,
    interestPt, // pa.
    repaymentPeriodInDays,
    defaultFeePercentage
) {
    loanProducts.push({
        id: loanProducts.length,
        minimumLoanInAcd,
        loanCollateralRatio,
        interestPt,
        repaymentPeriodInDays,
        defaultFeePercentage
    });
}

function getLoanProducts() {
    return loanProducts;
}

function takeLoan(actorId, loanProductId, loanAmountInAcd) {
    const loanProduct = loanProducts[loanProductId];

    if (!loanProduct) {
        throw new Error('takeLoan() error: Invalid loanProduct Id:' + loanProductId);
    }

    if (loanAmountInAcd < loanProduct.minimumLoanInAcd) {
        return false;
    }

    const collateralInEth = loanAmountInAcd * augmint.rates.ethToAcd / loanProduct.loanCollateralRatio;
    const interestPt = (1 + loanProduct.interestPt) ** (loanProduct.repaymentPeriodInDays / 365) - 1;
    const premiumInAcd = loanAmountInAcd * interestPt;
    const repaymentDue = premiumInAcd + loanAmountInAcd;
    const repayBy = clock.getTime() + loanProduct.repaymentPeriodInDays * ONE_DAY_IN_SECS;

    if (augmint.actors[actorId].balances.eth < collateralInEth) {
        console.error('takeLoan() eth balance below collateral', augmint.actors[actorId].balances.eth, collateralInEth);
        return false;
    }

    // move collateral user -> augmint
    augmint.actors[actorId].balances.eth -= collateralInEth;
    augmint.balances.collateralHeld += collateralInEth;

    // MINT acd -> user/interest pool
    augmint.actors[actorId].balances.acd += loanAmountInAcd;
    augmint.balances.interestHoldingPool += premiumInAcd;

    augmint.balances.openLoansAcd += loanAmountInAcd + premiumInAcd;
    const loanId = counter;
    counter++;

    // save loan:
    loans[actorId] = loans[actorId] || {};
    loans[actorId][loanId] = {
        id: loanId,
        collateralInEth,
        repayBy,
        loanAmountInAcd,
        premiumInAcd,
        repaymentDue,
        defaultFeePercentage: loanProduct.defaultFeePercentage
    };

    return loanId;
}

function repayLoan(actorId, loanId) {
    if (!loans[actorId] || !loans[actorId][loanId]) {
        throw new Error('repayLoan() error. Invalid actorId (' + actorId + ') or loanId(' + loanId + ')');
    }

    const loan = loans[actorId][loanId];

    if (augmint.actors[actorId].balances.acd < loan.repaymentDue) {
        console.error(
            'repayLoan() ACD balance of',
            augmint.actors[actorId].balances.acd,
            'is not enough to repay ',
            loan.repaymentDue
        );
        return false;
    }

    // repayment acd -> BURN acd
    augmint.actors[actorId].balances.acd -= loan.repaymentDue;
    // sanity check (NB: totalAcd is calculated on the fly by a getter)
    if (augmint.totalAcd < 0) {
        throw new Error('totalAcd has gone negative');
    }

    // move collateral augmint -> user
    augmint.balances.collateralHeld -= loan.collateralInEth;
    augmint.actors[actorId].balances.eth += loan.collateralInEth;
    // sanity check
    if (augmint.balances.collateralHeld < 0) {
        throw new Error('collateralHeld has gone negative');
    }

    // move interest from holding pool -> earned
    augmint.balances.interestHoldingPool -= loan.premiumInAcd;
    augmint.balances.interestEarnedPool += loan.premiumInAcd;

    augmint.balances.openLoansAcd -= loan.repaymentDue;

    // sanity check
    if (augmint.balances.interestHoldingPool < 0) {
        throw new Error('interestHoldingPool has gone negative');
    }

    // remove loan
    delete loans[actorId][loanId];
    return true;
}

function collectDefaultedLoan(actorId, loanId) {
    if (!loans[actorId] || !loans[actorId][loanId]) {
        return false;
    }

    const loan = loans[actorId][loanId];

    if (loan.repayBy >= clock.getTime()) {
        return false;
    }

    const targetDefaultFeeInEth = loan.loanAmountInAcd * augmint.rates.ethToAcd * (1 + loan.defaultFeePercentage);
    const actualDefaultFeeInEth = Math.min(loan.collateralInEth, targetDefaultFeeInEth);

    // move collateral -> augmint reserves/user
    augmint.balances.collateralHeld -= loan.collateralInEth;
    augmint.actors.reserve.balances.eth += actualDefaultFeeInEth;
    augmint.actors[actorId].balances.eth += loan.collateralInEth - actualDefaultFeeInEth;
    // sanity check
    if (augmint.balances.collateralHeld < 0) {
        throw new Error('collateralHeld has gone negative');
    }

    // move interest holding pool -> reserve
    augmint.balances.interestHoldingPool -= loan.premiumInAcd;
    augmint.actors.reserve.balances.acd += loan.premiumInAcd;

    augmint.balances.openLoansAcd -= loan.repaymentDue;
    augmint.balances.defaultedLoansAcd += loan.repaymentDue;
    // sanity check (NB: interestHoldingPool < 0 can only come about through an error in logic, not market forces)
    if (augmint.balances.interestHoldingPool < 0) {
        throw new Error('interestHoldingPool has gone negative');
    }

    // remove loan
    delete loans[actorId][loanId];
    logger.logMove(actorId, 'collectDefaultedLoan', { loanId: loanId, repaymentDue: loan.repaymentDue });
}

function collectAllDefaultedLoans() {
    const now = clock.getTime();

    Object.keys(loans).forEach(actorId => {
        Object.keys(loans[actorId]).forEach(loanId => {
            const loan = loans[actorId][loanId];

            if (loan && loan.repayBy < now) {
                collectDefaultedLoan(actorId, loanId);
            }
        });
    });
}

function getLoansForActor(actorId) {
    return loans[actorId];
}

module.exports = {
    createLoanProduct,
    getLoanProducts,
    takeLoan,
    repayLoan,
    collectDefaultedLoan,
    collectAllDefaultedLoans,
    getLoansForActor
};