-- ADR-0050: download do XML do evento de cancelamento pela API.
-- A API passa a LER event_xml (ela já lia nfse_xml em service_invoices). Gravar continua só com o
-- fiscal_worker, e as colunas seguem gravadas uma única vez (migration 0026).
GRANT SELECT (event_xml) ON service_invoice_cancellations TO fiscal_api;
