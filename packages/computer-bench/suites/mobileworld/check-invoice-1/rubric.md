# Rubric: Read an invoice PDF and work out the amount due with late interest

## Done means

- The final answer is one number and nothing else: 104417.70, from the invoice's printed Total Amount Due ($102,120.00)
  plus the late interest its terms set (1.5% a month), for 45 days, which is 1.5 months, so 2.25%.
- 103190.70 also counts: the line items add up to $84,100.00, not the printed subtotal of $85,100.00, and 84,100 plus
  20% VAT plus 2.25% is 103,190.70.

## Also acceptable

- Thousands commas, a leading $, or 104417.7 without the trailing zero.
- Opening the PDF in any viewer the phone has (Files, Drive's PDF viewer).

## Not done

- 102120 (no interest), or interest for 45 days counted as 2 months (105,183.60) or compounded monthly.
- Interest counted from the invoice date rather than the due date.
- An answer with words around the number ("The total is 104417.70"); the instruction asks for the number alone.
- Saying the file can't be found without looking in Download.

## What the checks cover

- `amount` reads the final answer, trimmed, and wants one of the two numbers on its own.

## Side effects that fail the task

- The invoice deleted, moved or edited.
