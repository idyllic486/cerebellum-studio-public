#@ String zip
#@ int w
#@ int h
// Reads every entry of an ROI ZIP with ImageJ's own ROI decoder (the code the ROI Manager uses) and prints what ImageJ makes of it.
import ij.IJ
import ij.io.RoiDecoder
import ij.measure.Measurements
import java.util.zip.ZipFile
def zf = new ZipFile(zip)
def imp = IJ.createImage("blank", "8-bit black", w, h, 1)
def entries = zf.entries().toList()
println "COUNT|" + entries.size()
entries.each { e ->
  def r = new RoiDecoder(zf.getInputStream(e).bytes, e.getName()).getRoi()
  if (r == null) { println "UNREADABLE|" + e.getName(); return }
  imp.setRoi(r)
  def st = imp.getStatistics(Measurements.AREA)
  def b = r.getBounds()
  println "ROI|" + e.getName() + "|" + r.getName() + "|" + r.getTypeAsString() + "|" + st.pixelCount + "|" + (r.isLine() ? r.getLength() : 0) + "|" + b.x + "|" + b.y + "|" + b.width + "|" + b.height
}
println "DONE"
