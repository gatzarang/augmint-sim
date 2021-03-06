'use strict';

const AugmintError = require('../augmint/augmint.error.js');
const Actor = require('./actor.js');
const ONE_DAY_IN_SECS = 24 * 60 * 60;
const defaultParams = {
    REPAY_X_DAYS_BEFORE: 1,
    BUY_ACD_X_DAYS_BEFORE_REPAY: 1,
    REPAYMENT_COST_ACD: 5, // TODO: this should be global
    WANTS_TO_BORROW_AMOUNT: 10000, // how much they want to borrow
    WANTS_TO_BORROW_AMOUNT_GROWTH_PA: 0.1, // increase in demand % pa.
    CHANCE_TO_TAKE_LOAN: 1, // % chance to take loan on a day (when there is no open loan)
    CHANCE_TO_SELL_ALL_ACD: 1, // % chance to sell all acd on a day (unless repayment is due soon)

    COLLATERAL_RATIO_SENSITIVITY: 1 /* not implemented! */,
    INTEREST_SENSITIVITY: 2 /* how sensitive is the borrower for marketLoanInterestRate ?
                            linear, marketChance = augmintInterest / (marketInterest * INTEREST_SENSITIVITY)  */
    // TODO: add loan forgotten chance param ( 0.1%?)
};

class BorrowerBasic extends Actor {
    constructor(id, balances, state, _params = {}) {
        super(id, balances, state, Object.assign({}, defaultParams, _params));
        this.triedToBuyForRepayment = false;
    }

    executeMoves(state) {
        const { currentTime } = state.meta;
        const loanProduct = state.augmint.loanProducts[0];
        let willRepaySoon = false;
        let timeUntilRepayment = 0;
        let repaymentDue = 0;
        let collateralValueAcd = 0;
        let wantToTake = false;
        let wantToTakeAmount = 0;
        let loanAmountNow = 0;

        if (this.loans.length !== 0) {
            /* we have a loan, is repayment due? */
            repaymentDue = this.loans[0].repaymentDue + this.params.REPAYMENT_COST_ACD;
            timeUntilRepayment = this.loans[0].repayBy - currentTime;
            collateralValueAcd = this.loans[0] && this.convertEthToAcd(this.loans[0].collateralInEth);
            willRepaySoon =
                currentTime >=
                    this.loans[0].repayBy -
                        (this.params.BUY_ACD_X_DAYS_BEFORE_REPAY + this.params.REPAY_X_DAYS_BEFORE) * ONE_DAY_IN_SECS &&
                repaymentDue < collateralValueAcd; // TODO: move this last bit to loanManager? Unlikely that anyone would repay a loan if collateral value below repayment amount
        } else {
            /* no open loans , can we and do we want we take a new loan? */
            const augmintInterest = loanProduct.interestPt;
            const marketInterest = state.augmint.params.marketLoanInterestRate;
            const marketChance = Math.min(1, marketInterest / (augmintInterest * this.params.INTEREST_SENSITIVITY));
            wantToTake = state.utils.byChanceInADay(this.params.CHANCE_TO_TAKE_LOAN * marketChance);
            if (wantToTake) {
                wantToTakeAmount = Math.min(
                    Math.floor(this.params.WANTS_TO_BORROW_AMOUNT * loanProduct.loanCollateralRatio),
                    Math.floor(this.convertEthToAcd(this.ethBalance) * loanProduct.loanCollateralRatio),
                    state.augmint.maxBorrowableAmount(0)
                );
                loanAmountNow = wantToTakeAmount < loanProduct.minimumLoanInAcd ? 0 : wantToTakeAmount;
            }

            // console.debug(
            //     `**** Willing TO TAKE LOAN. amount: ${loanAmountNow} wantToTakeAmount: ${wantToTakeAmount} maxBorrowableAmount: ${state.augmint.maxBorrowableAmount(
            //         0
            //     )}`
            // );
        }

        /* Get new loan  */
        if (loanAmountNow > 0) {
            // console.debug(
            //     `**** GOING TO TAKE LOAN. amount: ${loanAmountNow} maxBorrowableAmount: ${state.augmint.maxBorrowableAmount(
            //         0
            //     )}`
            // );
            this.triedToBuyForRepayment = false;

            if (wantToTake) {
                this.takeLoan(0, loanAmountNow);
            }
        }

        /* Sell all ACD (CHANCE_TO_SELL_ALL_ACD) unless repayment is due soon */
        if (this.acdBalance > 0 && !willRepaySoon && state.utils.byChanceInADay(this.params.CHANCE_TO_SELL_ALL_ACD)) {
            this.sellACD(this.acdBalance);
        }

        /* BUY ACD in advance for repayment */
        if (willRepaySoon) {
            if (
                this.acdBalance < repaymentDue &&
                /* rare edge case when ethValue recovered since last tick but
                    there would not be enough time to buy acd. We let it default, not even trying to buy ACD : */
                !this.triedToBuyForRepayment &&
                timeUntilRepayment >= state.meta.timeStep
            ) {
                // buys ACD for repayment
                let buyAmount = Math.max(0, repaymentDue - this.acdBalance);
                buyAmount /= 1 - state.augmint.params.exchangeFeePercentage;
                this.buyACD(buyAmount);
                this.triedToBuyForRepayment = true;
            }

            /* Repay REPAY_X_DAYS_BEFORE maturity  */
            if (
                repaymentDue < collateralValueAcd &&
                timeUntilRepayment <= this.params.REPAY_X_DAYS_BEFORE * ONE_DAY_IN_SECS &&
                (this.acdBalance >= repaymentDue ||
                    (timeUntilRepayment < state.meta.timeStep && this.triedToBuyForRepayment))
            ) {
                // repays ACD:
                if (!this.repayLoan(this.loans[0].id)) {
                    throw new AugmintError(
                        this.id +
                            ' couldn\'t repay.\n' +
                            'repaymentDue: ' +
                            repaymentDue +
                            '\nACD borrower balance: ' +
                            this.acdBalance
                    );
                }
            }
        }

        /* Increase loan  demand */
        if (state.meta.iteration % state.params.stepsPerDay === 0) {
            this.params.WANTS_TO_BORROW_AMOUNT *= (1 + this.params.WANTS_TO_BORROW_AMOUNT_GROWTH_PA) ** (1 / 365);
        }
        super.executeMoves(state);
    }
}

module.exports = BorrowerBasic;
