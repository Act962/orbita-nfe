/**
 * Schemas de TESTE que reproduzem a ESTRUTURA dos pacotes oficiais (schema principal com
 * xs:include de tipos no mesmo namespace + xs:import do namespace XMLDSig). Não são os XSDs
 * oficiais: estes serão baixados do portal na Fase 2a e versionados com hash (ADR-0013).
 */
export const NS = 'http://www.sped.fazenda.gov.br/nfse';
const DS = 'http://www.w3.org/2000/09/xmldsig#';

export const TIPOS_SIMPLES = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns="${NS}" targetNamespace="${NS}" elementFormDefault="qualified">
  <xs:simpleType name="TSTpAmb"><xs:restriction base="xs:string"><xs:enumeration value="1"/><xs:enumeration value="2"/></xs:restriction></xs:simpleType>
  <xs:simpleType name="TSDec15V2"><xs:restriction base="xs:string"><xs:pattern value="0|0\\.[0-9]{2}|[1-9][0-9]{0,14}(\\.[0-9]{2})?"/></xs:restriction></xs:simpleType>
  <xs:simpleType name="TSDesc"><xs:restriction base="xs:string"><xs:minLength value="1"/><xs:maxLength value="2000"/></xs:restriction></xs:simpleType>
</xs:schema>`;

// Substituto mínimo do xmldsig-core-schema.xsd (o oficial do W3C entra com o pacote oficial).
export const XMLDSIG_STUB = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="${DS}" elementFormDefault="qualified">
  <xs:element name="Signature"><xs:complexType><xs:sequence><xs:any processContents="lax" minOccurs="1" maxOccurs="unbounded" namespace="${DS}"/></xs:sequence><xs:attribute name="Id" type="xs:ID" use="optional"/></xs:complexType></xs:element>
</xs:schema>`;

export const DPS_SCHEMA = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns="${NS}" xmlns:ds="${DS}" targetNamespace="${NS}" elementFormDefault="qualified">
  <xs:include schemaLocation="tiposSimples_teste.xsd"/>
  <xs:import namespace="${DS}" schemaLocation="xmldsig-core-schema.xsd"/>
  <xs:element name="DPS">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="infDPS">
          <xs:complexType>
            <xs:sequence>
              <xs:element name="tpAmb" type="TSTpAmb"/>
              <xs:element name="dhEmi" type="xs:dateTime"/>
              <xs:element name="xDescServ" type="TSDesc"/>
              <xs:element name="vServ" type="TSDec15V2"/>
            </xs:sequence>
            <xs:attribute name="Id" type="xs:ID" use="required"/>
          </xs:complexType>
        </xs:element>
        <xs:element ref="ds:Signature" minOccurs="0"/>
      </xs:sequence>
      <xs:attribute name="versao" type="xs:string" use="required"/>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

export function dps(fields: { tpAmb?: string; vServ?: string; desc?: string; swapOrder?: boolean; extra?: string } = {}): string {
  const tp = `<tpAmb>${fields.tpAmb ?? '2'}</tpAmb>`;
  const dh = '<dhEmi>2026-11-09T10:00:00-03:00</dhEmi>';
  const ds = `<xDescServ>${fields.desc ?? 'Serviço de teste'}</xDescServ>`;
  const vs = fields.vServ === undefined ? '<vServ>1500.00</vServ>' : fields.vServ === '' ? '' : `<vServ>${fields.vServ}</vServ>`;
  const body = fields.swapOrder ? `${dh}${tp}${ds}${vs}` : `${tp}${dh}${ds}${vs}`;
  return `<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="${NS}" versao="1.01"><infDPS Id="DPS0001">${body}${fields.extra ?? ''}</infDPS></DPS>`;
}
